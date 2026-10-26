import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentBackend } from "./agents/backend.js";
import type { RiskReport, UnitAnalysis } from "./agents/schemas.js";
import type { AgentEvent, RunEvent, RunEventBody } from "./events.js";
import { diffMarkdown } from "./markdown/diff.js";
import { diffOpenApi } from "./swagger/diff.js";
import { isOpenApiDocument, loadOpenApi } from "./swagger/normalize.js";
import type { DiffResult, DocFormat, WorkUnit } from "./types.js";

export interface CompareOptions {
  baselinePath: string;
  candidatePath: string;
  /** Omit to run only the deterministic diff (no LLM calls). */
  backend?: AgentBackend;
  /** Max worker agents running at once. */
  concurrency?: number;
  /** Skip units whose changes are all `info`; they are still listed in the report. */
  skipInfoOnly?: boolean;
  /** Receives every event of the run (see src/events.ts). */
  onEvent?: (event: RunEvent) => void;
  /** Cancels the run: no new workers start, in-flight model calls are aborted, synthesis is skipped. */
  signal?: AbortSignal;
  /** Retry: reuse worker analyses from an earlier run of the same documents. */
  reuse?: ReuseOptions;
}

export interface ReuseOptions {
  fromRunId: string;
  /** Latest analysis per unit id from the earlier run. */
  analyses: Record<string, UnitAnalysis>;
  /** true: run workers for units without an analysis; false: carry their failure over (lead-only retry). */
  rerunMissing: boolean;
  /** The earlier run's worker failures, quoted for units that aren't re-run. */
  failures?: { unitId: string; error: string }[];
}

export interface ComparisonReport {
  generatedAt: string;
  baselinePath: string;
  candidatePath: string;
  /** True when agent output came from a simulated backend, not a model. */
  simulated: boolean;
  diff: DiffResult;
  /** Latest analysis per unit (follow-up investigations replace the first pass). */
  analyses: Record<string, UnitAnalysis>;
  investigations: { unitId: string; question: string; analysis: UnitAnalysis }[];
  failedUnits: { unitId: string; error: string }[];
  skippedUnits: string[];
  /** Units never sent to a worker because the run was stopped. */
  notRunUnits: string[];
  /** Units whose analysis was reused from an earlier run (retries). */
  reusedUnits: string[];
  /** Run this one retried, if any. */
  retryOf?: string;
  /** Why the run ended early, if it did. */
  stopped?: { reason: "cancelled" | "fatal"; error?: string };
  riskReport?: RiskReport;
  synthesisError?: string;
}

/**
 * Pipeline: detect format -> deterministic diff -> fan out one worker per
 * changed unit (code-driven) -> lead agent synthesizes risks, optionally
 * sending workers back to units (agent-driven).
 */
export async function compareDocs(options: CompareOptions): Promise<ComparisonReport> {
  const { backend, concurrency = 4, skipInfoOnly = false, onEvent = () => {} } = options;
  const runStarted = Date.now();
  let seq = 0;
  const emit = (body: RunEventBody) => onEvent({ ...body, seq: ++seq, t: Date.now() } as RunEvent);

  // Aborted by the caller (cancel) or internally when an agent error is fatal.
  const internal = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
  const agentCtx = { emit: (event: AgentEvent) => emit(event), signal };

  const diff = await diffFiles(options.baselinePath, options.candidatePath);
  emit({
    type: "run-start",
    format: diff.format,
    baselinePath: options.baselinePath,
    candidatePath: options.candidatePath,
    baselineVersion: diff.baselineVersion,
    candidateVersion: diff.candidateVersion,
    units: diff.units,
    agents: Boolean(backend),
    simulated: Boolean(backend?.simulated),
    concurrency,
  });

  const report: ComparisonReport = {
    generatedAt: new Date().toISOString(),
    baselinePath: options.baselinePath,
    candidatePath: options.candidatePath,
    simulated: Boolean(backend?.simulated),
    diff,
    analyses: {},
    investigations: [],
    failedUnits: [],
    skippedUnits: [],
    notRunUnits: [],
    reusedUnits: [],
    ...(options.reuse && { retryOf: options.reuse.fromRunId }),
  };
  const finish = () => {
    if (options.signal?.aborted) report.stopped = { reason: "cancelled" };
    emit({
      type: "run-end",
      durationMs: Date.now() - runStarted,
      failedUnits: report.failedUnits.length,
      ...(report.stopped && { stopped: report.stopped.reason, error: report.stopped.error }),
    });
    return report;
  };
  if (!backend || diff.units.length === 0) return finish();

  const toAnalyze: WorkUnit[] = [];
  for (const unit of diff.units) {
    const infoOnly = unit.changes.every((c) => c.severity === "info");
    // Description edits are info-level but often carry semantic changes, so
    // they are never skipped.
    const hasProseChange = unit.changes.some((c) => c.kind === "description-changed" || c.kind === "section-changed");
    if (skipInfoOnly && infoOnly && !hasProseChange) {
      report.skippedUnits.push(unit.id);
      emit({ type: "unit-skipped", unitId: unit.id, reason: "info-only" });
    } else {
      toAnalyze.push(unit);
    }
  }

  /** Runs one worker and emits its lifecycle; rethrows so callers decide how to handle failure. */
  const runWorker = async (unit: WorkUnit, question?: string): Promise<UnitAnalysis> => {
    const started = Date.now();
    emit({ type: "unit-start", unitId: unit.id, question });
    try {
      const analysis = await backend.analyzeUnit(unit, { ...agentCtx, question });
      emit({ type: "unit-done", unitId: unit.id, question, durationMs: Date.now() - started, analysis });
      return analysis;
    } catch (error) {
      emit({ type: "unit-failed", unitId: unit.id, question, durationMs: Date.now() - started, error: errorMessage(error) });
      if (!signal.aborted && backend.isFatal?.(error)) {
        report.stopped = { reason: "fatal", error: errorMessage(error) };
        internal.abort();
      }
      throw error;
    }
  };

  // Retry: analyses from an earlier run stand in for those workers.
  const reuse = options.reuse;
  const pending: WorkUnit[] = [];
  for (const unit of toAnalyze) {
    const prior = reuse?.analyses[unit.id];
    if (prior) {
      report.analyses[unit.id] = prior;
      report.reusedUnits.push(unit.id);
      emit({ type: "unit-reused", unitId: unit.id, analysis: prior, fromRun: reuse!.fromRunId });
    } else if (reuse && !reuse.rerunMissing) {
      const earlier = reuse.failures?.find((f) => f.unitId === unit.id)?.error ?? "not analyzed in the original run";
      report.failedUnits.push({ unitId: unit.id, error: `Not re-run: ${earlier}` });
      emit({ type: "unit-skipped", unitId: unit.id, reason: "not-rerun" });
    } else {
      pending.push(unit);
    }
  }

  await mapWithConcurrency(pending, concurrency, async (unit) => {
    if (signal.aborted) {
      report.notRunUnits.push(unit.id);
      emit({ type: "unit-skipped", unitId: unit.id, reason: "stopped" });
      return;
    }
    try {
      report.analyses[unit.id] = await runWorker(unit);
    } catch (error) {
      report.failedUnits.push({ unitId: unit.id, error: errorMessage(error) });
    }
  });
  if (signal.aborted) return finish();

  const unitsById = new Map(diff.units.map((u) => [u.id, u]));
  const synthesisStarted = Date.now();
  emit({ type: "synthesis-start" });
  try {
    report.riskReport = await backend.synthesize(
      { diff, analyses: Object.values(report.analyses), failedUnits: report.failedUnits },
      async (unitId, question) => {
        const unit = unitsById.get(unitId);
        if (!unit) throw new Error(`Unknown unit ${unitId}`);
        const analysis = await runWorker(unit, question);
        report.analyses[unitId] = analysis;
        report.investigations.push({ unitId, question, analysis });
        return analysis;
      },
      agentCtx,
    );
    emit({ type: "synthesis-done", durationMs: Date.now() - synthesisStarted, riskReport: report.riskReport });
  } catch (error) {
    report.synthesisError = errorMessage(error);
    emit({ type: "synthesis-failed", durationMs: Date.now() - synthesisStarted, error: report.synthesisError });
  }

  return finish();
}

export async function diffFiles(baselinePath: string, candidatePath: string): Promise<DiffResult> {
  const [bFormat, aFormat] = await Promise.all([detectFormat(baselinePath), detectFormat(candidatePath)]);
  if (bFormat !== aFormat) {
    throw new Error(`Both versions must use the same format (baseline: ${bFormat}, candidate: ${aFormat})`);
  }
  if (bFormat === "openapi") {
    const [b, a] = await Promise.all([loadOpenApi(baselinePath), loadOpenApi(candidatePath)]);
    return diffOpenApi(b, a);
  }
  const [b, a] = await Promise.all([readFile(baselinePath, "utf8"), readFile(candidatePath, "utf8")]);
  return diffMarkdown(b, a);
}

export async function detectFormat(path: string): Promise<DocFormat> {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
    const text = await readFile(path, "utf8");
    const doc = ext === ".json" ? JSON.parse(text) : parseYaml(text);
    if (isOpenApiDocument(doc)) return "openapi";
    throw new Error(`${path} is not a Swagger/OpenAPI document (no "swagger" or "openapi" field)`);
  }
  throw new Error(`Unsupported file type for ${path}; expected .md, .yaml, .yml or .json`);
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
