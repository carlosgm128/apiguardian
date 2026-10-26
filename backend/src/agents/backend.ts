import type { AgentEvent } from "../events.js";
import type { DiffResult, WorkUnit } from "../types.js";
import type { RiskReport, UnitAnalysis } from "./schemas.js";

export interface SynthesisInput {
  diff: DiffResult;
  analyses: UnitAnalysis[];
  /** Units whose worker failed; the lead should treat them as unreviewed. */
  failedUnits: { unitId: string; error: string }[];
}

/** Lets the lead agent send a worker back to a unit with a specific question. */
export type Investigate = (unitId: string, question: string) => Promise<UnitAnalysis>;

export interface AgentContext {
  /** Report what the agent is doing (LLM calls, tool calls) for observability. */
  emit: (event: AgentEvent) => void;
  /** Aborted when the run is cancelled; pass it to every model call. */
  signal: AbortSignal;
}

/**
 * The orchestrator depends only on this interface, so the pipeline can be
 * tested with a fake and other providers can be added later.
 */
export interface AgentBackend {
  /** True for backends that fake agent output (shown prominently in reports and the UI). */
  readonly simulated?: boolean;
  /** Worker: analyze one unit (optionally answering a follow-up question). */
  analyzeUnit(unit: WorkUnit, ctx: AgentContext & { question?: string }): Promise<UnitAnalysis>;
  /** Lead: turn all worker output into the final risk list. */
  synthesize(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport>;
  /**
   * True for errors no other unit can recover from (bad credentials, no
   * access); the orchestrator then stops the run instead of failing every unit.
   */
  isFatal?(error: unknown): boolean;
}
