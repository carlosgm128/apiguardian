import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AgentBackend } from "../agents/backend.js";
import { createBackend, selectEndpoints, type AgentConfig, type OllamaSettings } from "../agents/factory.js";
import { EventLog, type RunEvent } from "../events.js";
import { compareDocs, type ComparisonReport, type ReuseOptions } from "../orchestrator.js";
import { renderMarkdownReport } from "../report/markdown.js";

export type RunMode = AgentConfig["mode"];
export type RunStatus = "running" | "done" | "failed" | "cancelled";

export interface RunConfig extends AgentConfig {
  concurrency: number;
  skipInfo: boolean;
}

export interface RunSummary {
  units: number;
  breaking: number;
  warnings: number;
  failedUnits: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model ids seen in llm-call events with their token totals, for cost estimates. */
  usageByModel: Record<string, { provider?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  risks?: number;
  durationMs?: number;
}

export interface RunMeta {
  id: string;
  createdAt: string;
  status: RunStatus;
  /** Where the run came from: started in the dashboard, by `compare --ui`, or loaded for replay. */
  source: "dashboard" | "cli" | "replay" | "tracker";
  /** Set for runs the API tracker started when a tracked API's spec changed. */
  origin?: RunOrigin;
  config: RunConfig;
  baselineName: string;
  candidateName: string;
  summary: RunSummary;
  /** Set when the run could not start or stopped with an error. */
  error?: string;
  /** This run reruns another one (see RunManager.retry). */
  retryOf?: string;
  retryScope?: RetryScope;
  /** Later reruns of this run, oldest first. */
  retriedBy?: string[];
}

/** "lead": reuse every worker analysis; "failed": also rerun workers that failed; "all": start over. */
export type RetryScope = "lead" | "failed" | "all";

export interface RetryRequest {
  scope: RetryScope;
  /** Overrides on top of the original run's config, e.g. a different lead model or provider. */
  config?: Partial<RunConfig>;
}

export class RetryError extends Error {}

export interface RunOrigin {
  apiId: string;
  apiName: string;
  fromSnapshot: string;
  toSnapshot: string;
  /** "check": a new version was detected; "compare": someone compared two versions on demand. */
  trigger?: "check" | "compare" | "retry";
}

/** Called after a run's report has been written (report is absent if the run crashed). */
export type RunFinishedListener = (meta: RunMeta, report: ComparisonReport | undefined) => void | Promise<void>;

export interface StartRunInput {
  baseline: { name: string; content: string };
  candidate: { name: string; content: string };
  config: RunConfig;
  origin?: RunOrigin;
  /** Retry: worker analyses to reuse, and the run being retried. */
  reuse?: ReuseOptions;
  retryOf?: string;
  retryScope?: RetryScope;
}

export interface Sample {
  id: string;
  label: string;
  baseline: string;
  candidate: string;
}

interface RunHandle {
  meta: RunMeta;
  log?: EventLog;
  dir?: string;
  controller?: AbortController;
  /** Settles when the run finishes (dashboard and tracker runs). */
  done?: Promise<void>;
}

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".yaml", ".yml", ".json"]);

export interface RunManagerOptions {
  /** Where dashboard runs are stored; omit to keep runs in memory only. */
  runsDir?: string;
  /** Directory scanned for `<name>-v1.<ext>` / `<name>-v2.<ext>` sample pairs. */
  samplesDir?: string;
  /** Server-side Ollama settings for runs that use Ollama. */
  ollama?: OllamaSettings;
  /** Override how agents are created (tests). */
  createBackend?: (config: RunConfig) => AgentBackend | undefined;
}

/**
 * Starts, tracks, cancels and persists runs. Each dashboard run gets a
 * directory holding its inputs, events.jsonl, report.json, report.md and meta.json.
 */
export class RunManager {
  private readonly runs = new Map<string, RunHandle>();
  private readonly finishedListeners = new Set<RunFinishedListener>();
  private sampleList: Sample[] = [];
  private readonly createBackend: (config: RunConfig) => AgentBackend | undefined;

  constructor(private readonly options: RunManagerOptions = {}) {
    this.createBackend = options.createBackend ?? ((config) => createBackend(config, options.ollama));
  }

  /** Loads sample pairs and runs saved by earlier sessions. */
  async init(): Promise<this> {
    await this.loadSamples();
    const dir = this.options.runsDir;
    if (!dir || !existsSync(dir)) return this;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runDir = join(dir, entry.name);
      try {
        const meta = JSON.parse(await readFile(join(runDir, "meta.json"), "utf8")) as RunMeta;
        // A run still marked running belonged to a server that stopped mid-run.
        if (meta.status === "running") meta.status = "failed", meta.error ??= "Server stopped during the run";
        this.runs.set(meta.id, { meta, dir: runDir });
      } catch {
        // Not a run directory (or a half-written one); ignore it.
      }
    }
    return this;
  }

  list(): RunMeta[] {
    return [...this.runs.values()]
      .map((h) => this.withLiveSummary(h))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): RunMeta | undefined {
    const handle = this.runs.get(id);
    return handle && this.withLiveSummary(handle);
  }

  /** The run's event log: live for in-progress runs, loaded from disk otherwise. */
  async events(id: string): Promise<EventLog | undefined> {
    const handle = this.runs.get(id);
    if (!handle) return undefined;
    if (!handle.log && handle.dir && existsSync(join(handle.dir, "events.jsonl"))) {
      handle.log = await EventLog.load(join(handle.dir, "events.jsonl"));
    }
    return handle.log ?? new EventLog();
  }

  async report(id: string): Promise<ComparisonReport | undefined> {
    const dir = this.runs.get(id)?.dir;
    if (!dir || !existsSync(join(dir, "report.json"))) return undefined;
    return JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  }

  /** Replaces a run's report.md (e.g. once the applications it affects are known). */
  async writeReportMarkdown(id: string, markdown: string): Promise<void> {
    const dir = this.runs.get(id)?.dir;
    if (dir && existsSync(join(dir, "report.json"))) await writeFile(join(dir, "report.md"), markdown);
  }

  async reportMarkdown(id: string): Promise<string | undefined> {
    const dir = this.runs.get(id)?.dir;
    if (!dir || !existsSync(join(dir, "report.md"))) return undefined;
    return readFile(join(dir, "report.md"), "utf8");
  }

  async start(input: StartRunInput): Promise<RunMeta> {
    const exts = [input.baseline, input.candidate].map((f) => extname(f.name).toLowerCase());
    this.validateConfig(input.config);
    for (const ext of exts) {
      if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error(`Unsupported file type "${ext || "(none)"}"; expected .md, .yaml, .yml or .json`);
    }

    const id = newRunId();
    const dir = join(this.options.runsDir ?? join(process.cwd(), ".apiguardian", "runs"), id);
    await mkdir(dir, { recursive: true });
    const baselinePath = join(dir, `baseline${exts[0]}`);
    const candidatePath = join(dir, `candidate${exts[1]}`);
    await writeFile(baselinePath, input.baseline.content);
    await writeFile(candidatePath, input.candidate.content);

    const meta: RunMeta = {
      id,
      createdAt: new Date().toISOString(),
      status: "running",
      source: input.origin ? "tracker" : "dashboard",
      ...(input.retryOf && { retryOf: input.retryOf, retryScope: input.retryScope }),
      ...(input.origin && { origin: input.origin }),
      config: input.config,
      baselineName: input.baseline.name,
      candidateName: input.candidate.name,
      summary: summarize([]),
    };
    const controller = new AbortController();
    const log = new EventLog().writeTo(join(dir, "events.jsonl"));
    const handle: RunHandle = { meta, log, dir, controller };
    this.runs.set(id, handle);
    await this.saveMeta(handle);

    // Runs in the background; the caller gets the meta right away.
    handle.done = (async () => {
      let report: ComparisonReport | undefined;
      try {
        const backend = this.createBackend(input.config);
        report = await compareDocs({
          baselinePath,
          candidatePath,
          backend,
          concurrency: input.config.concurrency,
          skipInfoOnly: input.config.skipInfo,
          signal: controller.signal,
          reuse: input.reuse,
          onEvent: (e) => log.record(e),
        });
        await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
        await writeFile(join(dir, "report.md"), renderMarkdownReport(report));
        meta.status =
          report.stopped?.reason === "cancelled" ? "cancelled"
          : report.stopped?.reason === "fatal" || report.synthesisError ? "failed"
          : "done";
        meta.error = report.stopped?.error ?? report.synthesisError;
      } catch (error) {
        meta.status = "failed";
        meta.error = error instanceof Error ? error.message : String(error);
      } finally {
        meta.summary = summarize(log.events);
        handle.controller = undefined;
        await log.close();
        await this.saveMeta(handle);
        for (const listener of this.finishedListeners) {
          try {
            await listener(meta, report);
          } catch (error) {
            console.error(`Run ${id}: finished-listener failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    })();

    return meta;
  }

  /** Subscribe to finished runs; returns an unsubscribe function. */
  onRunFinished(listener: RunFinishedListener): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /** Throws if a run with this config could not start (e.g. unknown Ollama endpoint ids). */
  validateConfig(config: RunConfig): void {
    if (config.mode === "ollama" || config.leadProvider === "ollama") selectEndpoints(config, this.options.ollama);
  }

  /** Resolves when the run has finished (immediately for unknown or finished runs). */
  async waitForRun(id: string): Promise<RunMeta | undefined> {
    await this.runs.get(id)?.done;
    return this.get(id);
  }

  /**
   * Reruns a finished run on its saved input documents, optionally with a
   * different provider/model, reusing its worker analyses for "lead" and
   * "failed" scopes. Returns the new run.
   */
  async retry(id: string, request: RetryRequest): Promise<RunMeta> {
    const handle = this.runs.get(id);
    if (!handle) throw new RetryError(`No run ${id}`);
    if (handle.meta.status === "running") throw new RetryError("This run is still running: cancel it or wait until it finishes");
    if (!handle.dir) throw new RetryError("Only runs started from the dashboard or by API tracking keep their inputs and can be rerun");
    const files = await readdir(handle.dir);
    const baselineFile = files.find((f) => f.startsWith("baseline."));
    const candidateFile = files.find((f) => f.startsWith("candidate."));
    if (!baselineFile || !candidateFile) throw new RetryError("The original run's input documents are missing");

    const config: RunConfig = { ...handle.meta.config, ...request.config };
    let reuse: ReuseOptions | undefined;
    if (request.scope !== "all") {
      if (config.mode === "diff") throw new RetryError("Choose an agent provider: rerunning the lead needs agents");
      const report = await this.report(id);
      if (!report) throw new RetryError("The original run has no report to reuse: rerun everything instead");
      if (Object.keys(report.analyses).length === 0) {
        throw new RetryError("The original run has no worker analyses to reuse (it ran without agents, or every worker failed): rerun everything or the failed workers instead");
      }
      reuse = { fromRunId: id, analyses: report.analyses, rerunMissing: request.scope === "failed", failures: report.failedUnits };
    }

    const origin = handle.meta.origin;
    const meta = await this.start({
      baseline: { name: handle.meta.baselineName, content: await readFile(join(handle.dir, baselineFile), "utf8") },
      candidate: { name: handle.meta.candidateName, content: await readFile(join(handle.dir, candidateFile), "utf8") },
      config,
      // An on-demand comparison stays one; a retried change replaces the original's results.
      origin: origin && { ...origin, trigger: origin.trigger === "compare" ? "compare" : "retry" },
      reuse,
      retryOf: id,
      retryScope: request.scope,
    });
    (handle.meta.retriedBy ??= []).push(meta.id);
    await this.saveMeta(handle);
    return meta;
  }

  /** What a rerun of this run could reuse, for the dashboard's Rerun panel. */
  async retryInfo(id: string) {
    const meta = this.get(id);
    if (!meta) throw new RetryError(`No run ${id}`);
    const report = await this.report(id);
    const analyses = report ? Object.keys(report.analyses).length : 0;
    return {
      retryable: Boolean(this.runs.get(id)?.dir) && meta.status !== "running",
      analyses,
      failedUnits: report?.failedUnits.length ?? 0,
      notRunUnits: report?.notRunUnits.length ?? 0,
      units: report?.diff.units.length ?? meta.summary.units,
      leadError: report?.synthesisError ?? (report?.stopped ? report.stopped.error : undefined),
      hasRiskReport: Boolean(report?.riskReport),
    };
  }

  cancel(id: string): boolean {
    const controller = this.runs.get(id)?.controller;
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Registers a run driven elsewhere (CLI `compare --ui`, replay) so it can be viewed. */
  attach(log: EventLog, init: Pick<RunMeta, "source" | "baselineName" | "candidateName" | "config"> & { status?: RunStatus }): RunMeta {
    const meta: RunMeta = { id: newRunId(), createdAt: new Date().toISOString(), status: init.status ?? "running", summary: summarize(log.events), ...init };
    this.runs.set(meta.id, { meta, log });
    log.subscribe((e) => {
      if (e.type === "run-end") meta.status = e.stopped === "cancelled" ? "cancelled" : e.stopped === "fatal" ? "failed" : "done";
    });
    return meta;
  }

  get ollamaSettings(): OllamaSettings {
    return this.options.ollama ?? {};
  }

  samples(): Sample[] {
    return this.sampleList;
  }

  private async loadSamples(): Promise<void> {
    const dir = this.options.samplesDir;
    if (!dir || !existsSync(dir)) return;
    const files = await readdir(dir);
    this.sampleList = [];
    for (const file of files.sort()) {
      const m = /^(.+)-v1(\.[a-z]+)$/.exec(file);
      if (!m || !files.includes(`${m[1]}-v2${m[2]}`)) continue;
      this.sampleList.push({ id: m[1]!, label: `${m[1]} (${m[2]!.slice(1)})`, baseline: join(dir, file), candidate: join(dir, `${m[1]}-v2${m[2]}`) });
    }
  }

  private withLiveSummary(handle: RunHandle): RunMeta {
    return handle.meta.status === "running" && handle.log ? { ...handle.meta, summary: summarize(handle.log.events) } : handle.meta;
  }

  private async saveMeta(handle: RunHandle) {
    if (handle.dir) await writeFile(join(handle.dir, "meta.json"), JSON.stringify(handle.meta, null, 2));
  }
}

function newRunId(): string {
  // Sortable by creation time, unique enough for one machine.
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function summarize(events: RunEvent[]): RunSummary {
  const s: RunSummary = {
    units: 0, breaking: 0, warnings: 0, failedUnits: 0, llmCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usageByModel: {},
  };
  for (const e of events) {
    if (e.type === "run-start") {
      s.units = e.units.length;
      for (const u of e.units) for (const c of u.changes) {
        if (c.severity === "breaking") s.breaking++;
        if (c.severity === "warning") s.warnings++;
      }
    } else if (e.type === "llm-call") {
      s.llmCalls++;
      const m = (s.usageByModel[e.model] ??= { provider: e.provider, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        s[k] += e.usage[k];
        m[k] += e.usage[k];
      }
    } else if (e.type === "synthesis-done") {
      s.risks = e.riskReport.risks.length;
    } else if (e.type === "run-end") {
      s.durationMs = e.durationMs;
      s.failedUnits = e.failedUnits;
    }
  }
  return s;
}
