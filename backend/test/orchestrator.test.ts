import { describe, expect, it } from "vitest";
import type { AgentBackend, AgentContext, Investigate, SynthesisInput } from "../src/agents/backend.js";
import type { RiskReport, UnitAnalysis } from "../src/agents/schemas.js";
import { SimulatedBackend } from "../src/agents/simulated.js";
import type { RunEvent } from "../src/events.js";
import { compareDocs } from "../src/orchestrator.js";
import { renderMarkdownReport } from "../src/report/markdown.js";
import type { WorkUnit } from "../src/types.js";

const V1 = "backend/test/fixtures/petstore-v1.yaml";
const V2 = "backend/test/fixtures/petstore-v2.yaml";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Records calls; the lead investigates the first unit once, then submits. */
class FakeBackend implements AgentBackend {
  analyzed: { unitId: string; question?: string }[] = [];
  synthesisInput?: SynthesisInput;
  isFatal?: (error: unknown) => boolean;
  constructor(private readonly failUnit?: string) {}

  async analyzeUnit(unit: WorkUnit, ctx: AgentContext & { question?: string }): Promise<UnitAnalysis> {
    this.analyzed.push({ unitId: unit.id, question: ctx.question });
    ctx.emit({ type: "llm-call", role: "worker", unitId: unit.id, model: "fake", durationMs: 1, usage, stopReason: "end_turn" });
    if (unit.id === this.failUnit) throw new Error("boom");
    const question = ctx.question;
    return { unitId: unit.id, summary: question ? `follow-up: ${question}` : `summary of ${unit.id}`, findings: [], risks: [] };
  }

  async synthesize(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport> {
    this.synthesisInput = input;
    const target = input.analyses[0]!.unitId;
    ctx.emit({ type: "lead-tool-call", tool: "investigate", input: { unitId: target } });
    await investigate(target, "Is this really breaking?");
    return {
      overview: "Major version with breaking changes.",
      risks: [{ title: "Auth now required", severity: "critical", likelihood: "high", description: "d",
        failureScenario: "401 on every call", affectedUnits: [target], mitigation: "Add X-API-Key" }],
      crossCuttingNotes: [],
    };
  }
}

describe("compareDocs", () => {
  it("runs only the deterministic diff without a backend", async () => {
    const events: RunEvent[] = [];
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, onEvent: (e) => events.push(e) });
    expect(report.diff.units.length).toBeGreaterThan(0);
    expect(report.analyses).toEqual({});
    expect(report.riskReport).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["run-start", "run-end"]);
  });

  it("fans out one worker per unit, then lets the lead investigate", async () => {
    const backend = new FakeBackend();
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, backend, concurrency: 2 });

    const unitIds = report.diff.units.map((u) => u.id).sort();
    const firstPass = backend.analyzed.filter((a) => !a.question).map((a) => a.unitId).sort();
    expect(firstPass).toEqual(unitIds);

    expect(report.investigations).toHaveLength(1);
    const { unitId } = report.investigations[0]!;
    expect(report.analyses[unitId]!.summary).toBe("follow-up: Is this really breaking?");
    expect(report.riskReport?.risks[0]?.title).toBe("Auth now required");
  });

  it("emits an ordered, stamped event stream covering the whole run", async () => {
    const events: RunEvent[] = [];
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, backend: new FakeBackend(), onEvent: (e) => events.push(e) });
    const types = events.map((e) => e.type);
    const units = report.diff.units.length;

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(types[0]).toBe("run-start");
    expect(types.at(-1)).toBe("run-end");
    // first pass + one follow-up
    expect(types.filter((t) => t === "unit-start")).toHaveLength(units + 1);
    expect(types.filter((t) => t === "unit-done")).toHaveLength(units + 1);
    expect(types.filter((t) => t === "llm-call")).toHaveLength(units + 1);
    // the follow-up runs inside synthesis, after the lead's tool call
    const followUp = events.findIndex((e) => e.type === "unit-start" && e.question);
    expect(types.indexOf("synthesis-start")).toBeLessThan(types.indexOf("lead-tool-call"));
    expect(types.indexOf("lead-tool-call")).toBeLessThan(followUp);
    expect(followUp).toBeLessThan(types.indexOf("synthesis-done"));
  });

  it("keeps going when a worker fails and tells the lead", async () => {
    const backend = new FakeBackend("GET /owners");
    const events: RunEvent[] = [];
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, backend, onEvent: (e) => events.push(e) });
    expect(report.failedUnits).toEqual([{ unitId: "GET /owners", error: "boom" }]);
    expect(backend.synthesisInput?.failedUnits).toEqual(report.failedUnits);
    expect(report.riskReport).toBeDefined();
    expect(events.find((e) => e.type === "unit-failed")).toMatchObject({ unitId: "GET /owners", error: "boom" });
    expect(events.at(-1)).toMatchObject({ type: "run-end", failedUnits: 1 });
    expect(renderMarkdownReport(report)).toContain("`GET /owners`: failed (boom)");
  });

  it("stops the whole run on a fatal agent error instead of failing every unit", async () => {
    const backend = new FakeBackend("spec:global");
    backend.isFatal = () => true;
    const events: RunEvent[] = [];
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, backend, concurrency: 1, onEvent: (e) => events.push(e) });
    expect(report.stopped).toEqual({ reason: "fatal", error: "boom" });
    expect(report.failedUnits).toHaveLength(1);
    expect(report.notRunUnits.length).toBe(report.diff.units.length - 1);
    expect(backend.synthesisInput).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "run-end", stopped: "fatal", error: "boom" });
  });

  it("skips info-only units unless they contain prose edits", async () => {
    const backend = new FakeBackend();
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, backend, skipInfoOnly: true });
    expect(report.skippedUnits).toEqual(["GET /owners"]);
    expect(backend.analyzed.map((a) => a.unitId)).not.toContain("GET /owners");
  });

  it("rejects comparing different formats", async () => {
    await expect(compareDocs({ baselinePath: V1, candidatePath: "backend/test/fixtures/docs-v2.md" })).rejects.toThrow(
      /same format/,
    );
  });

  it("marks simulated runs in the report", async () => {
    const backend = new SimulatedBackend({ minDelayMs: 0, maxDelayMs: 1, seed: 1 });
    const report = await compareDocs({ baselinePath: V1, candidatePath: V2, backend });
    expect(report.simulated).toBe(true);
    expect(report.riskReport?.risks.length).toBeGreaterThan(0);
    expect(renderMarkdownReport(report)).toContain("Simulated run");
  });
});
