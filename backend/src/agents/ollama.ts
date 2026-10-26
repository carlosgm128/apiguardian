import { z } from "zod";
import type { OllamaEndpoint } from "../compute/endpoints.js";
import type { LlmUsage } from "../events.js";
import type { WorkUnit } from "../types.js";
import type { AgentBackend, AgentContext, Investigate, SynthesisInput } from "./backend.js";
import { LEAD_SYSTEM, WORKER_SYSTEM, renderSynthesisPrompt, renderUnitPrompt } from "./prompts.js";
import { RiskReportSchema, UnitAnalysisSchema, type RiskReport, type UnitAnalysis } from "./schemas.js";

// Runs workers and/or the lead on Ollama through its REST API (/api/chat,
// /api/tags, /api/show). Workers use schema-constrained JSON output; the lead
// uses tool calling when the model supports it, and falls back to a single
// structured answer (no follow-up investigations) when not. With several
// endpoints (one Ollama per GPU), worker calls go to the least busy one.

export interface OllamaBackendOptions {
  /** Single-endpoint shorthand. Default: $OLLAMA_HOST or http://127.0.0.1:11434. */
  baseUrl?: string;
  /** Ollama instances the workers are spread across (least busy first). Default: one endpoint at baseUrl. */
  endpoints?: OllamaEndpoint[];
  /** Instance the lead runs on. Default: the first worker endpoint. */
  leadEndpoint?: OllamaEndpoint;
  /** Default: the first installed model (preferring tool-capable ones for the lead). */
  workerModel?: string;
  leadModel?: string;
  /**
   * Context window per request. Ollama's own default is small and it silently
   * truncates longer prompts, so this is always sent; calls that fill it fail.
   */
  numCtx?: number;
  /** Let thinking-capable models think before answering (slower). Default false. */
  think?: boolean;
  temperature?: number;
  maxLeadIterations?: number;
}

export class OllamaUnavailableError extends Error {}
export class OllamaModelError extends Error {}
export class OllamaAgentError extends Error {}
/** Ollama answered 500 because it couldn't parse the model's tool-call output (model-dependent, often transient). */
export class OllamaToolCallError extends OllamaAgentError {}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface ChatResponse {
  model: string;
  message: ChatMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
}

/** A model on a specific Ollama instance. */
interface Target {
  endpoint: OllamaEndpoint;
  model: string;
}

interface ModelInfo {
  name: string;
  capabilities: string[];
}

const FIX_JSON = "Your reply was not valid JSON for the required schema";

export function defaultOllamaUrl(): string {
  const host = process.env.OLLAMA_HOST;
  if (!host) return "http://127.0.0.1:11434";
  return host.includes("://") ? host : `http://${host}`;
}

export class OllamaBackend implements AgentBackend {
  private readonly workerPool: OllamaEndpoint[];
  private readonly leadEp: OllamaEndpoint;
  private readonly inFlight = new Map<string, number>();
  private nextIndex = 0;
  private readonly opts: Required<Omit<OllamaBackendOptions, "baseUrl" | "endpoints" | "leadEndpoint" | "workerModel" | "leadModel">> &
    Pick<OllamaBackendOptions, "workerModel" | "leadModel">;
  /** Keyed by endpoint url, and by `url|model` for capabilities. */
  private readonly models = new Map<string, Promise<ModelInfo[]>>();
  private readonly capabilities = new Map<string, Promise<string[]>>();

  constructor(options: OllamaBackendOptions = {}) {
    const single: OllamaEndpoint = { id: "default", url: (options.baseUrl ?? defaultOllamaUrl()).replace(/\/+$/, "") };
    this.workerPool = options.endpoints?.length ? options.endpoints : [single];
    this.leadEp = options.leadEndpoint ?? this.workerPool[0]!;
    this.opts = {
      workerModel: options.workerModel,
      leadModel: options.leadModel,
      numCtx: options.numCtx ?? 16384,
      think: options.think ?? false,
      temperature: options.temperature ?? 0.2,
      maxLeadIterations: options.maxLeadIterations ?? 12,
    };
  }

  isFatal(error: unknown): boolean {
    return error instanceof OllamaUnavailableError || error instanceof OllamaModelError;
  }

  async analyzeUnit(unit: WorkUnit, ctx: AgentContext & { question?: string }): Promise<UnitAnalysis> {
    const endpoint = this.acquire();
    try {
      const target = { endpoint, model: await this.resolveModel("worker", endpoint) };
      const messages: ChatMessage[] = [
        { role: "system", content: WORKER_SYSTEM },
        { role: "user", content: renderUnitPrompt(unit, ctx.question) },
      ];
      const parsed = await this.structured(target, messages, UnitAnalysisSchema, ctx, { role: "worker", unitId: unit.id });
      return { unitId: unit.id, ...parsed };
    } finally {
      this.release(endpoint);
    }
  }

  async synthesize(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport> {
    // Count the lead as load on its endpoint so follow-up workers prefer other GPUs.
    this.inFlight.set(this.leadEp.id, (this.inFlight.get(this.leadEp.id) ?? 0) + 1);
    try {
      return await this.runLead(input, investigate, ctx);
    } finally {
      this.release(this.leadEp);
    }
  }

  private async runLead(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport> {
    const target = { endpoint: this.leadEp, model: await this.resolveModel("lead", this.leadEp) };
    const model = target.model;
    const caps = await this.modelCapabilities(target);
    const user = renderSynthesisPrompt(input);
    if (!caps.includes("tools")) {
      ctx.emit({ type: "lead-text", text: `${model} does not support tool calling; producing the report in one step without follow-up investigations.` });
      return this.structured(
        target,
        [
          { role: "system", content: `${LEAD_SYSTEM}\n\nTools are not available in this session: reply with the final risk report as JSON matching the schema.` },
          { role: "user", content: user },
        ],
        RiskReportSchema,
        ctx,
        { role: "lead" },
      );
    }

    const knownUnits = new Set(input.diff.units.map((u) => u.id));
    const tools = [
      {
        type: "function",
        function: {
          name: "investigate",
          description: "Send a worker reviewer back to one work unit with a specific question. Returns the worker's updated analysis as JSON.",
          parameters: jsonSchema(z.object({ unitId: z.string().describe("A unit id from <units>"), question: z.string().describe("What the worker should check or clarify") })),
        },
      },
      {
        type: "function",
        function: {
          name: "submit_risk_report",
          description: "Submit the final risk report. Call exactly once, when the analysis is complete.",
          parameters: jsonSchema(RiskReportSchema),
        },
      },
    ];
    const messages: ChatMessage[] = [
      { role: "system", content: LEAD_SYSTEM },
      { role: "user", content: user },
    ];
    let pendingInput = user;
    let nudged = false;
    let toolParseErrors = 0;

    for (let turn = 0; turn < this.opts.maxLeadIterations; turn++) {
      let res: ChatResponse;
      try {
        res = await this.chat(target, { messages, tools }, ctx, { role: "lead" }, { system: turn === 0 ? LEAD_SYSTEM : undefined, user: pendingInput });
      } catch (error) {
        if (!(error instanceof OllamaToolCallError)) throw error;
        toolParseErrors++;
        if (toolParseErrors === 1) {
          ctx.emit({ type: "lead-text", text: `Ollama couldn't parse ${model}'s tool call (${error.message}); retrying the turn.` });
          continue;
        }
        ctx.emit({ type: "lead-text", text: `Ollama couldn't parse ${model}'s tool calls twice; producing the report in one step instead.` });
        break;
      }
      messages.push(res.message);
      const calls = res.message.tool_calls ?? [];
      if (res.message.content.trim()) ctx.emit({ type: "lead-text", text: stripThinking(res.message.content) });

      if (calls.length === 0) {
        if (nudged) break;
        nudged = true;
        pendingInput = "Call submit_risk_report now with the final report.";
        messages.push({ role: "user", content: pendingInput });
        continue;
      }

      const results: string[] = [];
      let report: RiskReport | undefined;
      for (const call of calls) {
        const { name, arguments: args } = call.function;
        let result: string;
        if (name === "investigate") {
          ctx.emit({ type: "lead-tool-call", tool: name, input: args });
          const unitId = String(args.unitId ?? "");
          const question = String(args.question ?? "");
          if (!knownUnits.has(unitId)) result = `Unknown unit id "${unitId}". Use an id from <units>.`;
          else {
            try {
              result = JSON.stringify(await investigate(unitId, question));
            } catch (error) {
              result = `Investigation failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        } else if (name === "submit_risk_report") {
          const parsed = RiskReportSchema.safeParse(normalizeReport(args));
          ctx.emit({ type: "lead-tool-call", tool: name, input: { risks: Array.isArray(args.risks) ? args.risks.length : undefined, valid: parsed.success } });
          if (parsed.success) {
            report = parsed.data;
            result = "Report recorded.";
          } else {
            result = `The report does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix it and call submit_risk_report again.`;
          }
        } else {
          result = `Unknown tool "${name}".`;
        }
        messages.push({ role: "tool", tool_name: name, content: result });
        results.push(`[${name} result]\n${result}`);
      }
      if (report) return report;
      pendingInput = results.join("\n\n");
    }

    // The model never produced a valid submission through tools; ask for the
    // report directly as structured output so the run still gets one.
    ctx.emit({ type: "lead-text", text: "No valid submit_risk_report call; requesting the report as structured output." });
    messages.push({ role: "user", content: "Reply now with only the final risk report as JSON matching the schema." });
    return this.structured(target, messages, RiskReportSchema, ctx, { role: "lead" });
  }

  // ---- internals -----------------------------------------------------------

  /** Chat with a JSON-schema `format`, validate, and retry once with the validation error. */
  private async structured<T extends z.ZodType>(
    target: Target,
    messages: ChatMessage[],
    schema: T,
    ctx: AgentContext,
    who: { role: "worker" | "lead"; unitId?: string },
  ): Promise<z.infer<T>> {
    const format = jsonSchema(schema);
    let pendingInput = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const system = messages.find((m) => m.role === "system")?.content;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.chat(target, { messages, format }, ctx, who, { system: attempt === 0 ? system : undefined, user: pendingInput });
      const text = stripThinking(res.message.content);
      let problem: string;
      try {
        const parsed = schema.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
        problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (attempt === 1) throw new OllamaAgentError(`${target.model} returned invalid JSON for ${who.unitId ?? "the risk report"}: ${problem}`);
      messages.push({ role: "assistant", content: res.message.content });
      pendingInput = `${FIX_JSON} (${problem}). Reply with only the corrected JSON object.`;
      messages.push({ role: "user", content: pendingInput });
    }
    throw new OllamaAgentError("unreachable");
  }

  private async chat(
    target: Target,
    body: { messages: ChatMessage[]; format?: unknown; tools?: unknown[] },
    ctx: AgentContext,
    who: { role: "worker" | "lead"; unitId?: string },
    prompt: { system?: string; user: string },
  ): Promise<ChatResponse> {
    const caps = await this.modelCapabilities(target);
    const started = Date.now();
    let res: ChatResponse;
    try {
      res = await this.request<ChatResponse>(
        "/api/chat",
        {
          model: target.model,
          ...body,
          stream: false,
          // Only thinking-capable models accept `think`.
          ...(caps.includes("thinking") && { think: this.opts.think }),
          options: { num_ctx: this.opts.numCtx, temperature: this.opts.temperature },
        },
        ctx.signal,
        target.endpoint,
      );
    } catch (error) {
      // Record failed calls too, so the Inference view shows what was sent and why it failed.
      if (!ctx.signal.aborted) {
        ctx.emit({
          type: "llm-call",
          provider: "ollama",
          endpoint: target.endpoint.id,
          role: who.role,
          unitId: who.unitId,
          model: target.model,
          durationMs: Date.now() - started,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "error",
          prompt,
          output: `[request failed] ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
    // prompt_eval_count is the whole prompt; the cached count is a subset of it.
    // Split them like Claude's usage (input = uncached, cache read = cached).
    const promptTokens = res.prompt_eval_count ?? 0;
    const cached = Math.min(res.prompt_eval_cached_count ?? 0, promptTokens);
    const usage: LlmUsage = {
      inputTokens: promptTokens - cached,
      outputTokens: res.eval_count ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
    ctx.emit({
      type: "llm-call",
      provider: "ollama",
      endpoint: target.endpoint.id,
      role: who.role,
      unitId: who.unitId,
      model: res.model,
      durationMs: Date.now() - started,
      usage,
      stopReason: res.done_reason ?? null,
      prompt,
      output: renderMessage(res.message),
    });
    if (promptTokens >= this.opts.numCtx - 1) {
      throw new OllamaAgentError(
        `Prompt filled the ${this.opts.numCtx}-token context window of ${res.model} (Ollama truncates silently); raise num_ctx (--ollama-num-ctx)`,
      );
    }
    if (res.done_reason === "length") {
      throw new OllamaAgentError(
        `${res.model} hit the output length limit: it kept generating until the ${this.opts.numCtx}-token context window was full. ` +
          "Small models often do this on long tasks; rerun with a larger model or another provider, or raise --ollama-num-ctx.",
      );
    }
    return res;
  }

  /** Least busy worker endpoint; ties rotate so idle endpoints all get work. */
  private acquire(): OllamaEndpoint {
    const pool = this.workerPool;
    const load = (ep: OllamaEndpoint) => this.inFlight.get(ep.id) ?? 0;
    let best = pool[this.nextIndex % pool.length]!;
    for (let i = 1; i < pool.length; i++) {
      const ep = pool[(this.nextIndex + i) % pool.length]!;
      if (load(ep) < load(best)) best = ep;
    }
    this.nextIndex++;
    this.inFlight.set(best.id, load(best) + 1);
    return best;
  }

  private release(endpoint: OllamaEndpoint) {
    this.inFlight.set(endpoint.id, Math.max(0, (this.inFlight.get(endpoint.id) ?? 1) - 1));
  }

  private async resolveModel(role: "worker" | "lead", endpoint: OllamaEndpoint): Promise<string> {
    const configured = role === "worker" ? this.opts.workerModel : this.opts.leadModel;
    if (configured) return configured;
    let list = this.models.get(endpoint.url);
    if (!list) {
      list = this.request<{ models: ModelInfo[] }>("/api/tags", undefined, undefined, endpoint).then((r) => r.models);
      this.models.set(endpoint.url, list);
      list.catch(() => this.models.delete(endpoint.url));
    }
    const usable = (await list).filter((m) => !m.capabilities || m.capabilities.includes("completion"));
    const pick = (role === "lead" && usable.find((m) => m.capabilities?.includes("tools"))) || usable[0];
    if (!pick) throw new OllamaModelError(`No models installed in Ollama "${endpoint.id}" at ${endpoint.url}; run: ollama pull qwen3.5:4b`);
    return pick.name;
  }

  private modelCapabilities({ endpoint, model }: Target): Promise<string[]> {
    const key = `${endpoint.url}|${model}`;
    let caps = this.capabilities.get(key);
    if (!caps) {
      caps = this.request<{ capabilities?: string[] }>("/api/show", { model }, undefined, endpoint).then((r) => r.capabilities ?? ["completion"]);
      this.capabilities.set(key, caps);
      caps.catch(() => this.capabilities.delete(key));
    }
    return caps;
  }

  private async request<T>(path: string, body: unknown, signal: AbortSignal | undefined, endpoint: OllamaEndpoint): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${endpoint.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new OllamaUnavailableError(`Cannot reach Ollama "${endpoint.id}" at ${endpoint.url} (${error instanceof Error ? error.message : error}). Is it running? Try: ollama serve`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404) {
      const model = body && typeof body === "object" && "model" in body ? String(body.model) : "?";
      throw new OllamaModelError(`${data.error ?? "model not found"} on Ollama "${endpoint.id}"; run: ollama pull ${model}`);
    }
    if (!res.ok) {
      const message = `Ollama ${path} failed (${res.status}): ${data.error ?? res.statusText}`;
      const toolParse = res.status === 500 && body && typeof body === "object" && "tools" in body && /xml|parse|tool call|syntax/i.test(data.error ?? "");
      throw toolParse ? new OllamaToolCallError(message) : new OllamaAgentError(message);
    }
    return data as T;
  }
}

const LEVEL_SYNONYMS: Record<string, string> = { breaking: "critical", severe: "critical", warning: "medium", moderate: "medium", info: "low", minor: "low" };

/**
 * Tool arguments, unlike `format` output, aren't grammar-constrained, and
 * small models mix vocabularies ("info" for low, "High"). Fold the obvious
 * variants before validation; anything else still fails with the schema error.
 */
function normalizeReport(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.risks)) return args;
  const level = (v: unknown) => {
    if (typeof v !== "string") return v;
    const key = v.trim().toLowerCase();
    return LEVEL_SYNONYMS[key] ?? key;
  };
  return {
    ...args,
    risks: args.risks.map((r: unknown) => {
      if (!r || typeof r !== "object") return r;
      const risk = r as Record<string, unknown>;
      return { ...risk, severity: level(risk.severity), likelihood: level(risk.likelihood) };
    }),
  };
}

/** JSON Schema for Ollama `format` / tool parameters. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Some models inline their reasoning in <think> tags even with `format`. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function renderMessage(message: ChatMessage): string {
  const parts: string[] = [];
  if (message.thinking) parts.push(`[thinking]\n${message.thinking}`);
  if (message.content) parts.push(message.content);
  for (const call of message.tool_calls ?? []) parts.push(`[tool_use ${call.function.name}]\n${JSON.stringify(call.function.arguments, null, 2)}`);
  return parts.join("\n\n");
}
