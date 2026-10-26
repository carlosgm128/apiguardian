import { estimateCost, sumCosts } from "../lib/pricing.js";
import type { EventOf, LlmCall, RiskReport, RunEvent, UnitAnalysis, WorkUnit } from "../types.js";

// The dashboard's view of a run is rebuilt purely from its event stream, so a
// live run, a reconnect and a replay all render the same. applyEvent mutates
// in place (the stream can be long); the hook bumps a version to re-render.

export type AttemptStatus = "running" | "done" | "failed";
export type UnitStatus = "queued" | "running" | "done" | "failed" | "skipped" | "not-run" | "diff-only";

export interface Attempt {
  start: number;
  end: number | null;
  question?: string;
  status: AttemptStatus;
  analysis?: UnitAnalysis;
  error?: string;
  /** Taken from an earlier run (rerun), not produced by a worker in this one. */
  reusedFrom?: string;
}

export interface UnitState {
  unit: WorkUnit;
  attempts: Attempt[];
  skipped?: "info-only" | "stopped" | "not-rerun";
  calls: LlmCall[];
}

export type LeadItem =
  | { kind: "llm"; event: LlmCall }
  | { kind: "tool"; event: EventOf<"lead-tool-call"> }
  | { kind: "text"; event: EventOf<"lead-text"> };

export interface LeadState {
  start: number | null;
  end: number | null;
  status: "idle" | "running" | "done" | "failed";
  items: LeadItem[];
  calls: LlmCall[];
  report: RiskReport | null;
  error: string | null;
}

export interface RunState {
  start: EventOf<"run-start"> | null;
  end: EventOf<"run-end"> | null;
  t0: number | null;
  lastSeq: number;
  events: RunEvent[];
  units: Map<string, UnitState>;
  lead: LeadState;
  calls: LlmCall[];
}

export function initialRunState(): RunState {
  return {
    start: null,
    end: null,
    t0: null,
    lastSeq: 0,
    events: [],
    units: new Map(),
    lead: { start: null, end: null, status: "idle", items: [], calls: [], report: null, error: null },
    calls: [],
  };
}

/** Returns false for duplicates (history is resent on reconnect). */
export function applyEvent(s: RunState, e: RunEvent): boolean {
  if (e.seq <= s.lastSeq) return false;
  s.lastSeq = e.seq;
  s.events.push(e);
  s.t0 ??= e.t;
  const unit = "unitId" in e && e.unitId !== undefined ? s.units.get(e.unitId) : undefined;

  switch (e.type) {
    case "run-start":
      s.start = e;
      s.t0 = e.t;
      for (const u of e.units) s.units.set(u.id, { unit: u, attempts: [], calls: [] });
      break;
    case "unit-skipped":
      if (unit) unit.skipped = e.reason;
      break;
    case "unit-reused":
      unit?.attempts.push({ start: e.t, end: e.t, status: "done", analysis: e.analysis, reusedFrom: e.fromRun });
      break;
    case "unit-start":
      unit?.attempts.push({ start: e.t, end: null, question: e.question, status: "running" });
      break;
    case "unit-done":
    case "unit-failed": {
      const attempt = unit && [...unit.attempts].reverse().find((a) => a.status === "running" && a.question === e.question);
      if (attempt) {
        attempt.end = e.t;
        attempt.status = e.type === "unit-done" ? "done" : "failed";
        if (e.type === "unit-done") attempt.analysis = e.analysis;
        else attempt.error = e.error;
      }
      break;
    }
    case "llm-call":
      s.calls.push(e);
      if (e.role === "worker") unit?.calls.push(e);
      else {
        s.lead.calls.push(e);
        s.lead.items.push({ kind: "llm", event: e });
      }
      break;
    case "lead-tool-call":
      s.lead.items.push({ kind: "tool", event: e });
      break;
    case "lead-text":
      s.lead.items.push({ kind: "text", event: e });
      break;
    case "synthesis-start":
      Object.assign(s.lead, { start: e.t, status: "running" });
      break;
    case "synthesis-done":
      Object.assign(s.lead, { end: e.t, status: "done", report: e.riskReport });
      break;
    case "synthesis-failed":
      Object.assign(s.lead, { end: e.t, status: "failed", error: e.error });
      break;
    case "run-end":
      s.end = e;
      break;
  }
  return true;
}

export function unitStatus(s: RunState, u: UnitState): UnitStatus {
  if (u.skipped === "info-only") return "skipped";
  if (u.skipped === "stopped" || u.skipped === "not-rerun") return "not-run";
  if (u.attempts.length === 0) return s.start?.agents ? (s.end ? "not-run" : "queued") : "diff-only";
  if (u.attempts.some((a) => a.status === "running")) return "running";
  return u.attempts.some((a) => a.status === "done") ? "done" : "failed";
}

/** Latest successful analysis (a follow-up replaces the first pass). */
export function latestAnalysis(u: UnitState): UnitAnalysis | undefined {
  return [...u.attempts].reverse().find((a) => a.analysis)?.analysis;
}

export function callCost(call: LlmCall): number | null {
  return estimateCost(call.model, call.usage, call.provider);
}

export interface Totals {
  units: number;
  byStatus: Record<UnitStatus, number>;
  breaking: number;
  warnings: number;
  followUps: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number | null;
  /** Wall-clock time spent inside model calls, summed across parallel calls. */
  llmMs: number;
}

export function totals(s: RunState): Totals {
  const byStatus: Record<UnitStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0, "not-run": 0, "diff-only": 0 };
  let breaking = 0;
  let warnings = 0;
  let followUps = 0;
  for (const u of s.units.values()) {
    byStatus[unitStatus(s, u)]++;
    followUps += u.attempts.filter((a) => a.question).length;
    for (const c of u.unit.changes) {
      if (c.severity === "breaking") breaking++;
      if (c.severity === "warning") warnings++;
    }
  }
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens") => s.calls.reduce((n, c) => n + c.usage[k], 0);
  return {
    units: s.units.size,
    byStatus,
    breaking,
    warnings,
    followUps,
    calls: s.calls.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cost: sumCosts(s.calls.map(callCost)),
    llmMs: s.calls.reduce((n, c) => n + c.durationMs, 0),
  };
}

export type Phase = { tone: "idle" | "running" | "done" | "failed" | "cancelled"; label: string };

export function phase(s: RunState): Phase {
  if (!s.start) return { tone: "idle", label: "Waiting for run…" };
  if (s.end) {
    if (s.end.stopped === "cancelled") return { tone: "cancelled", label: "Cancelled" };
    if (s.end.stopped === "fatal") return { tone: "failed", label: "Stopped: fatal error" };
    if (s.lead.status === "failed" || s.end.failedUnits > 0) return { tone: "failed", label: "Finished with failures" };
    return { tone: "done", label: s.start.agents ? "Finished" : "Diff complete" };
  }
  if (s.lead.status === "running") return { tone: "running", label: "Lead agent synthesizing" };
  return { tone: "running", label: "Workers running" };
}
