import { describe, expect, it } from "vitest";
import { SimulatedBackend } from "../../backend/src/agents/simulated.js";
import type { RunEvent } from "../../backend/src/events.js";
import { compareDocs } from "../../backend/src/orchestrator.js";
import { estimateCost } from "../src/lib/pricing.js";
import { applyEvent, initialRunState, latestAnalysis, phase, totals, unitStatus } from "../src/state/runState.js";

async function simulatedEvents(options: { failureRate?: number; signal?: AbortSignal } = {}): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  await compareDocs({
    baselinePath: "backend/test/fixtures/petstore-v1.yaml",
    candidatePath: "backend/test/fixtures/petstore-v2.yaml",
    backend: new SimulatedBackend({ minDelayMs: 1, maxDelayMs: 2, seed: 11, failureRate: options.failureRate }),
    signal: options.signal,
    onEvent: (e) => events.push(e),
  });
  return events;
}

describe("dashboard run state", () => {
  it("rebuilds a finished run from its events", async () => {
    const events = await simulatedEvents();
    const s = initialRunState();
    for (const e of events) applyEvent(s, e);

    const t = totals(s);
    expect(t.units).toBe(6);
    expect(t.byStatus.done).toBe(6);
    expect(t.followUps).toBe(1);
    expect(t.calls).toBe(events.filter((e) => e.type === "llm-call").length);
    expect(t.cost).toBeNull(); // simulated model has no price
    expect(phase(s)).toEqual({ tone: "done", label: "Finished" });
    expect(s.lead.report?.risks.length).toBeGreaterThan(0);

    const followedUp = [...s.units.values()].find((u) => u.attempts.length === 2)!;
    expect(latestAnalysis(followedUp)?.summary).toMatch(/follow-up/);
  });

  it("ignores duplicated history after a reconnect", async () => {
    const events = await simulatedEvents();
    const s = initialRunState();
    for (const e of events) applyEvent(s, e);
    const before = s.events.length;
    for (const e of events) expect(applyEvent(s, e)).toBe(false);
    expect(s.events.length).toBe(before);
  });

  it("shows partial state mid-run", async () => {
    const events = await simulatedEvents();
    const firstDone = events.findIndex((e) => e.type === "unit-done");
    const s = initialRunState();
    for (const e of events.slice(0, firstDone)) applyEvent(s, e);
    const statuses = [...s.units.values()].map((u) => unitStatus(s, u));
    expect(statuses).toContain("running");
    expect(statuses).toContain("queued");
    expect(phase(s).tone).toBe("running");
  });

  it("reports failures and cancellation", async () => {
    const failed = initialRunState();
    for (const e of await simulatedEvents({ failureRate: 1 })) applyEvent(failed, e);
    expect(totals(failed).byStatus.failed).toBe(6);
    expect(phase(failed).label).toBe("Finished with failures");

    const controller = new AbortController();
    controller.abort();
    const cancelled = initialRunState();
    for (const e of await simulatedEvents({ signal: controller.signal })) applyEvent(cancelled, e);
    expect(phase(cancelled).tone).toBe("cancelled");
    expect(totals(cancelled).byStatus["not-run"]).toBe(6);
  });

  it("shows reused analyses as done units with no new calls", async () => {
    const first = initialRunState();
    for (const e of await simulatedEvents()) applyEvent(first, e);
    const analyses = Object.fromEntries([...first.units.values()].map((u) => [u.unit.id, latestAnalysis(u)!]));

    const events: RunEvent[] = [];
    await compareDocs({
      baselinePath: "backend/test/fixtures/petstore-v1.yaml",
      candidatePath: "backend/test/fixtures/petstore-v2.yaml",
      backend: new SimulatedBackend({ minDelayMs: 1, maxDelayMs: 2, seed: 5 }),
      reuse: { fromRunId: "earlier", analyses, rerunMissing: false },
      onEvent: (e) => events.push(e),
    });
    const s = initialRunState();
    for (const e of events) applyEvent(s, e);
    const t = totals(s);
    expect(t.byStatus.done).toBe(6);
    expect([...s.units.values()].every((u) => u.attempts[0]?.reusedFrom === "earlier")).toBe(true);
    // only the lead (and any follow-up it asked for) made model calls
    expect(s.calls.every((c) => c.role === "lead" || c.unitId !== undefined)).toBe(true);
    expect(s.calls.filter((c) => c.role === "worker").length).toBeLessThanOrEqual(1);
    expect(phase(s).tone).toBe("done");
  });

  it("estimates cost from list prices", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCost("claude-opus-5-5", usage)).toBeCloseTo(4 + 2);
    expect(estimateCost("simulated", usage)).toBeNull();
  });
});
