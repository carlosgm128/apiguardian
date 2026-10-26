import type { WorkUnit } from "../types.js";
import type { AgentBackend, AgentContext, Investigate, SynthesisInput } from "./backend.js";
import { LEAD_SYSTEM, WORKER_SYSTEM, renderSynthesisPrompt, renderUnitPrompt } from "./prompts.js";
import type { RiskReport, UnitAnalysis } from "./schemas.js";

// Fakes agent behaviour (delays, token counts, prompts, investigations,
// failures) from the deterministic changes, so the pipeline and UI can be
// exercised without API credentials. Output is labelled simulated everywhere.

export interface SimulatedBackendOptions {
  /** Worker call duration range in ms. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Probability (0-1) that a first-pass worker call fails. */
  failureRate?: number;
  /** Seed for repeatable runs; random when omitted. */
  seed?: number;
}

export class SimulatedBackend implements AgentBackend {
  readonly simulated = true;
  private readonly random: () => number;
  private readonly opts: Required<Omit<SimulatedBackendOptions, "seed">>;

  constructor(options: SimulatedBackendOptions = {}) {
    this.random = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 32));
    this.opts = {
      minDelayMs: options.minDelayMs ?? 600,
      maxDelayMs: options.maxDelayMs ?? 3500,
      failureRate: options.failureRate ?? 0,
    };
  }

  async analyzeUnit(unit: WorkUnit, ctx: AgentContext & { question?: string }): Promise<UnitAnalysis> {
    const durationMs = await this.pause(ctx.signal);
    const user = renderUnitPrompt(unit, ctx.question);
    const fails = !ctx.question && this.random() < this.opts.failureRate;
    const analysis = fails ? undefined : this.fakeAnalysis(unit, ctx.question);
    ctx.emit({
      type: "llm-call",
      provider: "simulated",
      role: "worker",
      unitId: unit.id,
      model: "simulated",
      durationMs,
      usage: this.usage(user.length, fails ? 0 : 400 + unit.changes.length * 120),
      stopReason: fails ? "refusal" : "end_turn",
      prompt: { system: WORKER_SYSTEM, user },
      output: analysis ? JSON.stringify({ ...analysis, unitId: undefined }, null, 2) : "",
    });
    if (!analysis) throw new Error(`Simulated worker failure on ${unit.id}`);
    return analysis;
  }

  async synthesize(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport> {
    const firstPrompt = renderSynthesisPrompt(input);
    let pendingResults: string[] = [];
    let turn = 0;
    const leadTurn = async (output: string, outputTokens: number, stopReason: string) => {
      const durationMs = await this.pause(ctx.signal);
      ctx.emit({
        type: "llm-call",
      provider: "simulated",
        role: "lead",
        model: "simulated",
        durationMs,
        usage: this.usage(firstPrompt.length + turn * 2000, outputTokens),
        stopReason,
        prompt: turn === 0 ? { system: LEAD_SYSTEM, user: firstPrompt } : { user: pendingResults.join("\n\n") },
        output,
      });
      turn++;
      pendingResults = [];
    };

    // Turn 1: look at the most breaking unit more closely.
    const breakingCount = (id: string) =>
      input.diff.units.find((u) => u.id === id)?.changes.filter((c) => c.severity === "breaking").length ?? 0;
    const target = [...input.analyses].sort((a, b) => breakingCount(b.unitId) - breakingCount(a.unitId))[0];
    const text = `Reviewing ${input.analyses.length} worker analyses.`;
    const question = "Are any of these breaking changes covered by a documented migration path?";
    await leadTurn(target ? `${text}\n\n[tool_use investigate]\n${JSON.stringify({ unitId: target.unitId, question }, null, 2)}` : text, 300, "tool_use");
    ctx.emit({ type: "lead-text", text });
    if (target) {
      ctx.emit({ type: "lead-tool-call", tool: "investigate", input: { unitId: target.unitId, question } });
      const result = await investigate(target.unitId, question).catch((e: Error) => `Investigation failed: ${e.message}`);
      pendingResults.push(`[investigate result]\n${typeof result === "string" ? result : JSON.stringify(result)}`);
    }

    // Turn 2: submit.
    const risks = input.analyses.flatMap((a) =>
      a.risks.map((r) => ({
        title: r.description.replace(/^Clients relying on the baseline may break: /, ""),
        severity: "high" as const,
        likelihood: r.likelihood,
        description: r.description,
        failureScenario: r.failureScenario,
        affectedUnits: [a.unitId],
        mitigation: r.mitigation,
      })),
    );
    const report: RiskReport = {
      overview: `Simulated report: ${risks.length} risks from ${input.analyses.length} analyzed units.`,
      risks,
      crossCuttingNotes: input.failedUnits.map((f) => `${f.unitId} was not reviewed: ${f.error}`),
    };
    await leadTurn(`[tool_use submit_risk_report]\n${JSON.stringify(report, null, 2)}`, 200 + risks.length * 150, "tool_use");
    ctx.emit({ type: "lead-tool-call", tool: "submit_risk_report", input: { risks: risks.length } });
    pendingResults.push("[submit_risk_report result]\nReport recorded. Reply with a one-line confirmation.");
    await leadTurn("Risk report submitted.", 20, "end_turn");
    return report;
  }

  private fakeAnalysis(unit: WorkUnit, question?: string): UnitAnalysis {
    const flagged = unit.changes.filter((c) => c.severity !== "info");
    return {
      unitId: unit.id,
      summary: question
        ? `Simulated follow-up. Question: ${question}`
        : `Simulated analysis: ${unit.changes.length} changes, ${flagged.length} need attention.`,
      findings: unit.changes.map((c) => ({
        title: c.kind,
        what: c.message,
        how: c.before !== undefined || c.after !== undefined ? `${fmt(c.before)} -> ${fmt(c.after)}` : "See change list",
        severity: c.severity,
        baselineRef: c.location,
        changeIds: [c.id],
      })),
      risks: unit.changes
        .filter((c) => c.severity === "breaking")
        .map((c) => ({
          description: `Clients relying on the baseline may break: ${c.message}`,
          failureScenario: `A request or response touching ${c.location}`,
          affectedConsumers: "Clients built against the baseline docs",
          likelihood: "medium" as const,
          impact: "high" as const,
          mitigation: "Update clients before adopting the new version",
        })),
    };
  }

  private pause(signal: AbortSignal): Promise<number> {
    const { minDelayMs, maxDelayMs } = this.opts;
    const ms = Math.round(minDelayMs + this.random() * (maxDelayMs - minDelayMs));
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Request was aborted."));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(ms);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Request was aborted."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private usage(promptChars: number, outputTokens: number) {
    return { inputTokens: Math.round(promptChars / 4) + 900, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
}

function fmt(value: unknown): string {
  return value === undefined ? "(none)" : typeof value === "string" ? value : JSON.stringify(value);
}

/** Small seeded PRNG so simulated runs can be repeated. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
