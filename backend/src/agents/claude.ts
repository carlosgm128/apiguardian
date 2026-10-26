import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { LlmUsage } from "../events.js";
import type { WorkUnit } from "../types.js";
import type { AgentBackend, AgentContext, Investigate, SynthesisInput } from "./backend.js";
import { LEAD_SYSTEM, WORKER_SYSTEM, renderSynthesisPrompt, renderUnitPrompt } from "./prompts.js";
import { RiskReportSchema, UnitAnalysisSchema, type RiskReport, type UnitAnalysis } from "./schemas.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeBackendOptions {
  client?: Anthropic;
  workerModel?: string;
  leadModel?: string;
  workerEffort?: Effort;
  leadEffort?: Effort;
  /** Cap on lead-agent turns, including investigate round-trips. */
  maxLeadIterations?: number;
}

// Server-side refusal fallback: a policy decline is retried on Anthropic's
// recommended substitute model inside the same call instead of failing.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AgentError extends Error {}


export class ClaudeBackend implements AgentBackend {
  private readonly client: Anthropic;
  private readonly opts: Required<Omit<ClaudeBackendOptions, "client">>;

  constructor(options: ClaudeBackendOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.opts = {
      workerModel: options.workerModel ?? "claude-opus-5-5",
      leadModel: options.leadModel ?? "claude-opus-5-5",
      workerEffort: options.workerEffort ?? "medium",
      leadEffort: options.leadEffort ?? "high",
      maxLeadIterations: options.maxLeadIterations ?? 12,
    };
  }

  isFatal(error: unknown): boolean {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return true;
    // Thrown by the client before any request when no credentials are configured.
    return error instanceof Error && error.message.startsWith("Could not resolve authentication method");
  }

  async analyzeUnit(unit: WorkUnit, ctx: AgentContext & { question?: string }): Promise<UnitAnalysis> {
    const started = Date.now();
    const user = renderUnitPrompt(unit, ctx.question);
    const response = await this.client.beta.messages.parse(
      {
        model: this.opts.workerModel,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: WORKER_SYSTEM,
        output_config: {
          effort: this.opts.workerEffort,
          format: betaZodOutputFormat(UnitAnalysisSchema),
        },
        messages: [{ role: "user", content: user }],
      },
      { signal: ctx.signal },
    );
    ctx.emit({
      type: "llm-call",
      provider: "claude",
      role: "worker",
      unitId: unit.id,
      model: response.model,
      durationMs: Date.now() - started,
      usage: toUsage(response.usage),
      stopReason: response.stop_reason,
      prompt: { system: WORKER_SYSTEM, user },
      output: response.parsed_output ? JSON.stringify(response.parsed_output, null, 2) : renderContent(response.content),
    });

    if (response.stop_reason === "refusal") {
      throw new AgentError(`Worker declined unit ${unit.id} (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AgentError(`Worker output for unit ${unit.id} hit max_tokens`);
    }
    if (!response.parsed_output) {
      throw new AgentError(`Worker returned no parseable analysis for unit ${unit.id}`);
    }
    return { unitId: unit.id, ...response.parsed_output };
  }

  async synthesize(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport> {
    const knownUnits = new Set(input.diff.units.map((u) => u.id));
    let submitted: RiskReport | undefined;
    // Tool execution happens between runner iterations; it is subtracted so
    // the lead's llm-call durations measure only the API calls. Tool results
    // are kept so the next turn's llm-call can show what the lead was sent.
    let toolMs = 0;
    let toolResults: string[] = [];
    const tool = async (name: string, fn: () => Promise<string>): Promise<string> => {
      const started = Date.now();
      try {
        const result = await fn();
        toolResults.push(`[${name} result]\n${result}`);
        return result;
      } finally {
        toolMs += Date.now() - started;
      }
    };

    const investigateTool = betaZodTool({
      name: "investigate",
      description:
        "Send a worker reviewer back to one work unit with a specific question. Returns the worker's updated analysis as JSON.",
      inputSchema: z.object({
        unitId: z.string().describe("A unit id from <units>"),
        question: z.string().describe("What the worker should check or clarify"),
      }),
      run: ({ unitId, question }) =>
        tool("investigate", async () => {
          if (!knownUnits.has(unitId)) return `Unknown unit id "${unitId}". Use an id from <units>.`;
          try {
            return JSON.stringify(await investigate(unitId, question));
          } catch (error) {
            return `Investigation failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }),
    });

    const submitTool = betaZodTool({
      name: "submit_risk_report",
      description: "Submit the final risk report. Call exactly once, when the analysis is complete.",
      inputSchema: RiskReportSchema,
      run: (report) =>
        tool("submit_risk_report", async () => {
          submitted = report;
          return "Report recorded. Reply with a one-line confirmation.";
        }),
    });

    const firstPrompt = renderSynthesisPrompt(input);
    const runner = this.client.beta.messages.toolRunner(
      {
        model: this.opts.leadModel,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        // The loop resends the whole conversation each turn; cache the prefix.
        cache_control: { type: "ephemeral" },
        system: LEAD_SYSTEM,
        output_config: { effort: this.opts.leadEffort },
        tools: [investigateTool, submitTool],
        max_iterations: this.opts.maxLeadIterations,
        messages: [{ role: "user", content: firstPrompt }],
      },
      { signal: ctx.signal },
    );

    let turnStarted = Date.now();
    let turn = 0;
    for await (const message of runner) {
      ctx.emit({
        type: "llm-call",
      provider: "claude",
        role: "lead",
        model: message.model,
        durationMs: Date.now() - turnStarted - toolMs,
        usage: toUsage(message.usage),
        stopReason: message.stop_reason,
        prompt: turn === 0 ? { system: LEAD_SYSTEM, user: firstPrompt } : { user: toolResults.join("\n\n") },
        output: renderContent(message.content),
      });
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) ctx.emit({ type: "lead-text", text: block.text });
        if (block.type === "tool_use") {
          // The report itself arrives in synthesis-done; don't duplicate it here.
          const shown = block.name === "submit_risk_report" ? { risks: (block.input as RiskReport).risks?.length } : block.input;
          ctx.emit({ type: "lead-tool-call", tool: block.name, input: shown });
        }
      }
      turn++;
      turnStarted = Date.now();
      toolMs = 0;
      toolResults = [];
    }
    const final = await runner.done();

    if (!submitted) {
      const reason = final.stop_reason === "refusal" ? "the lead agent declined" : `stop_reason=${final.stop_reason}`;
      throw new AgentError(`Lead agent finished without submitting a risk report (${reason})`);
    }
    return submitted;
  }
}

/** Text and tool calls of a response, for the inference view. */
function renderContent(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[tool_use ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      return `[${block.type}]`;
    })
    .join("\n\n");
}

function toUsage(usage: Anthropic.Beta.BetaUsage): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
