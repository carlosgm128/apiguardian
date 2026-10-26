// The demo's stand-in for `apiguardian serve`: answers the dashboard's /api
// calls in the browser from recorded runs (frontend/src/demo/recording.json).
// Runs are replayed event by event, compressed in time; applications, channels,
// impacts and tracked APIs live in memory and reset on reload. Nothing is sent
// over the network.
import type { Operation, RetryInfo, StartRunRequest } from "../api";
import { operationKey } from "../lib/operations";
import type { CheckRecord, Delivery, Dependency, EndpointStatus, GpuInfo, ImpactRecord, RunConfig, RunEvent, RunMeta, Severity, Snapshot, TrackedApi } from "../types";
import { computeImpact, meetsSeverity, reportCsv, reportMarkdown, summarize } from "./mirror";
import type { Application, Channel, ComparisonReport, DemoRecording, DemoSeed, RecordedRun, RecordingRole, VersionRef } from "./types";

export interface DemoResponse {
  status: number;
  /** JSON body. */
  body?: unknown;
  /** Text body for downloads. */
  text?: string;
  contentType?: string;
  filename?: string;
}

export interface DemoNotice {
  id: number;
  kind: "info" | "notification";
  title: string;
  detail?: string;
  /** The request a notification channel would have received. */
  payload?: { url: string; body: string };
}

export interface DemoServerOptions {
  now?: () => number;
  /** Agent runs are compressed to about this long (they took minutes on real models). */
  replayMs?: number;
}

type RunStatus = RunMeta["status"];
type RunOrigin = NonNullable<RunMeta["origin"]>;

interface LiveRun {
  meta: RunMeta;
  /** Events emitted so far. */
  events: RunEvent[];
  report?: ComparisonReport;
  markdown?: string;
  /** Recording this run was replayed from, if it maps to one exactly. */
  role?: RecordingRole;
  timers: ReturnType<typeof setTimeout>[];
  listeners: Set<(e: RunEvent) => void>;
  startedAt: number;
}

interface ApiState {
  api: TrackedApi;
  versions: Snapshot[];
  checks: CheckRecord[];
  /** Versions "Check now" will find next (the recorded tracker's later snapshots). */
  pending: Snapshot[];
  snapshots: Map<string, unknown>;
  operations: Map<string, Operation[]>;
}

interface Source {
  events: RunEvent[];
  report: ComparisonReport;
  markdown: string;
  status: RunStatus;
  error?: string;
  config: RunConfig;
}

export const REDACTED = "••••••";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULT_AGENTS: RunConfig = { mode: "diff", concurrency: 4, skipInfo: false };
const CLAUDE_MESSAGE = "The demo has no Claude recordings (and no credentials): pick Ollama, Simulated or Diff only.";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class DemoServer {
  private readonly runs = new Map<string, LiveRun>();
  private readonly apis = new Map<string, ApiState>();
  private apps: Application[];
  private channels: Channel[];
  private readonly impacts = new Map<string, ImpactRecord>();
  private deliveries: Delivery[] = [];
  private readonly noticeListeners = new Set<(n: DemoNotice) => void>();
  private noticeSeq = 0;
  private readonly now: () => number;
  private readonly replayMs: number;
  private readonly startedAt: string;

  constructor(private readonly rec: DemoRecording, seed: DemoSeed, options: DemoServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.replayMs = options.replayMs ?? 25_000;
    this.startedAt = new Date(this.now()).toISOString();
    this.apps = structuredClone(seed.applications);
    this.channels = structuredClone(seed.channels);

    const now = this.now();
    // A few days of history, ending just before the visitor arrived.
    this.preload("docs-ollama", now - 2 * DAY - 3 * HOUR);
    this.preload("petstore-gpu", now - DAY - 5 * HOUR);
    this.preload("lead-failed", now - 3 * HOUR);
    this.loadTrackedApi(now);
    for (const app of this.apps) this.backfill(app);
  }

  // ---- dashboard hooks ---------------------------------------------------------

  /** Live events for a run: history first, then new ones. Returns an unsubscribe function. */
  subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    for (const e of run.events) listener(e);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /**
   * Newest run matching `filter`, for the tours. `started` is true for runs
   * started in this visit (as opposed to the preloaded history).
   */
  latestRun(filter: (meta: RunMeta, role: RecordingRole | undefined, started: boolean) => boolean): string | undefined {
    return [...this.runs.values()]
      .filter((r) => filter(r.meta, r.role, r.timers.length > 0 || r.startedAt >= Date.parse(this.startedAt)))
      .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt))[0]?.meta.id;
  }

  onNotice(listener: (n: DemoNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  /** Stops pending replays (tests). */
  dispose() {
    for (const run of this.runs.values()) for (const t of run.timers) clearTimeout(t);
  }

  async handle(method: string, rawUrl: string, body?: unknown): Promise<DemoResponse> {
    try {
      return await this.route(method.toUpperCase(), new URL(rawUrl, "http://demo.local"), body ?? {});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      return { status, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  // ---- routing -------------------------------------------------------------------

  private async route(method: string, url: URL, body: any): Promise<DemoResponse> {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "api") throw new HttpError(404, "Not found");
    const [, kind, id, sub, extra] = parts;
    const ok = (data: unknown, status = 200): DemoResponse => ({ status, body: data });

    if (kind === "version" && method === "GET") return ok({ startedAt: this.startedAt, version: "demo", current: "demo", stale: false });
    if (kind === "status" && method === "GET") return ok(this.status());
    if (kind === "compute" && method === "GET") return ok({ gpus: this.gpus(), endpoints: this.endpoints() });

    if (kind === "runs") {
      if (!id && method === "GET") return ok(this.listRuns());
      if (!id && method === "POST") return ok(this.startFromRequest(body as StartRunRequest), 201);
      const run = this.requireRun(id!);
      if (!sub && method === "GET") return ok(this.metaOf(run));
      if (sub === "cancel" && method === "POST") return this.cancel(run) ? ok(this.metaOf(run), 202) : ok({ error: "Run is not running", run: run.meta }, 409);
      if (sub === "retry-info" && method === "GET") return ok(this.retryInfo(run));
      if (sub === "retry" && method === "POST") return ok(this.retry(run, body), 201);
      if (sub === "report" && method === "GET") {
        if (!run.report) throw new HttpError(404, "No report yet");
        return ok(run.report);
      }
      if (sub === "applications" && method === "GET") {
        const applications = this.applicationsForRun(run);
        return ok({ tracked: applications !== undefined, applications: applications ?? [] });
      }
      if (sub === "report.md" && method === "GET") {
        if (!run.markdown) throw new HttpError(404, "No report yet");
        return { status: 200, text: run.markdown, contentType: "text/markdown", filename: `${run.meta.id}-report.md` };
      }
      throw new HttpError(404, "Not found");
    }

    if (kind === "apis") {
      if (!id && method === "GET") return ok(this.listApis());
      if (!id && method === "POST") return ok(this.addApi(body), 201);
      if (id === "discover" && method === "POST") return ok(this.discover(String(body.url ?? "")));
      const state = this.requireApi(id!);
      if (!sub && method === "GET") return ok(this.apiDetail(state));
      if (!sub && method === "PATCH") return ok(this.updateApi(state, body));
      if (!sub && method === "DELETE") {
        this.apis.delete(state.api.id);
        return ok({ deleted: state.api.id });
      }
      if (sub === "check" && method === "POST") return ok(this.check(state, "manual"));
      if (sub === "compare" && method === "POST") return ok(this.compareVersions(state, String(body.from), String(body.to)), 201);
      if (sub === "operations" && method === "GET") return ok(state.operations.get(state.versions.at(-1)?.id ?? "") ?? []);
      if (sub === "snapshots" && extra && method === "GET") {
        const content = state.snapshots.get(extra);
        if (content === undefined) throw new HttpError(404, "No such snapshot");
        return { status: 200, text: JSON.stringify(content, null, 2), contentType: "application/json", filename: `${state.api.id}-${extra}.json` };
      }
      throw new HttpError(404, "Not found");
    }

    if (kind === "apps") {
      if (!id && method === "GET") return ok(this.listApps());
      if (!id && method === "POST") return ok(this.createApp(body), 201);
      const app = this.requireApp(id!);
      if (!sub && method === "GET") return ok(this.appDetail(app));
      if (!sub && method === "PATCH") return ok(this.updateApp(app, body));
      if (!sub && method === "DELETE") {
        this.apps = this.apps.filter((a) => a !== app);
        for (const [key, impact] of this.impacts) if (impact.appId === app.id) this.impacts.delete(key);
        return ok({ deleted: app.id });
      }
      if (sub === "backfill" && method === "POST") return ok({ impacts: this.backfill(app) });
      throw new HttpError(404, "Not found");
    }

    if (kind === "channels") {
      if (!id && method === "GET") return ok(this.channels.map(redactChannel));
      if (!id && method === "POST") return ok(this.createChannel(body), 201);
      const channel = this.requireChannel(id!);
      if (!sub && method === "PATCH") return ok(this.updateChannel(channel, body));
      if (!sub && method === "DELETE") {
        this.channels = this.channels.filter((c) => c !== channel);
        for (const app of this.apps) app.channelIds = app.channelIds.filter((c) => c !== channel.id);
        return ok({ deleted: channel.id });
      }
      if (sub === "test" && method === "POST") return ok(this.deliver(channel, { test: true }));
      throw new HttpError(404, "Not found");
    }

    if (kind === "deliveries" && method === "GET") return ok([...this.deliveries].reverse());

    if (kind === "reports" && id === "breaking" && method === "GET") {
      const q = url.searchParams;
      const min = q.get("min");
      const filter = {
        sinceDays: q.get("since") ? Number(q.get("since")) : undefined,
        appId: q.get("app") || undefined,
        apiId: q.get("api") || undefined,
        minSeverity: min === "breaking" || min === "warning" || min === "info" ? (min as Severity) : undefined,
      };
      const rows = this.impactsFor(filter);
      const format = q.get("format");
      if (format === "md") return { status: 200, text: reportMarkdown(rows, filter), contentType: "text/markdown", filename: "breaking-changes.md" };
      if (format === "csv") return { status: 200, text: reportCsv(rows), contentType: "text/csv", filename: "breaking-changes.csv" };
      return ok(rows);
    }

    throw new HttpError(404, "Not found");
  }

  // ---- status and compute ------------------------------------------------------

  private status() {
    return {
      credentials: false,
      samples: [
        { id: "petstore", label: "petstore (yaml)" },
        { id: "docs", label: "docs (md)" },
      ],
      ollama: { endpoints: this.endpoints(), numCtx: 16384, think: false },
      gpus: this.gpus(),
    };
  }

  private busy(endpoint: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.meta.status !== "running" || run.meta.config.mode !== "ollama") continue;
      const ids = run.meta.config.workerEndpoints ?? ["gpu-a"];
      if (ids.includes(endpoint) || run.meta.config.leadEndpoint === endpoint) n++;
    }
    return n;
  }

  private endpoints(): EndpointStatus[] {
    const models = [
      { name: "qwen3.5:4b", size: "3.4 GB", tools: true },
      { name: "qwen3.5:latest", size: "6.6 GB", tools: true },
      { name: "qwen3.5:0.8b", size: "1.0 GB", tools: true },
    ];
    return ["gpu-a", "gpu-b"].map((id, i) => ({
      id,
      url: `http://127.0.0.1:${11500 + i}`,
      gpus: String(i),
      managed: true,
      reachable: true,
      version: "0.13.2",
      models,
      loaded: this.busy(id) ? [{ name: "qwen3.5:4b", sizeMb: 4120, vramMb: 4120, expiresAt: new Date(this.now() + 5 * 60_000).toISOString() }] : [],
    }));
  }

  private gpus() {
    const t = this.now() / 1000;
    const gpus: GpuInfo[] = ["gpu-a", "gpu-b"].map((endpoint, index) => {
      const load = this.busy(endpoint);
      const wobble = Math.round(6 * Math.sin(t / 3 + index));
      return {
        index,
        uuid: `GPU-demo-000${index}`,
        name: "NVIDIA GeForce RTX 4090",
        memoryTotalMb: 24564,
        memoryUsedMb: load ? 5200 + 40 * wobble : 410,
        utilizationPct: load ? Math.min(99, 78 + wobble) : 1,
        temperatureC: load ? 66 + Math.round(wobble / 2) : 38,
      };
    });
    return { available: true, gpus };
  }

  // ---- runs --------------------------------------------------------------------

  private listRuns(): RunMeta[] {
    return [...this.runs.values()].map((r) => this.metaOf(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private metaOf(run: LiveRun): RunMeta {
    return run.meta.status === "running" ? { ...run.meta, summary: summarize(run.events) } : run.meta;
  }

  private requireRun(id: string): LiveRun {
    const run = this.runs.get(id);
    if (!run) throw new HttpError(404, `No run ${id}`);
    return run;
  }

  /** A finished recorded run, moved in time so it happened `at`. */
  private preload(role: RecordingRole, at: number, patch: Partial<RunMeta> = {}): LiveRun {
    const recorded = structuredClone(this.rec.runs[role]);
    const shift = at - Date.parse(recorded.meta.createdAt);
    const events = recorded.events.map((e) => ({ ...e, t: e.t + shift }));
    const run: LiveRun = {
      meta: { ...recorded.meta, ...patch, createdAt: new Date(at).toISOString(), summary: summarize(events) },
      events,
      report: { ...recorded.report, generatedAt: new Date(at + (recorded.meta.summary.durationMs ?? 0)).toISOString() },
      markdown: recorded.markdown,
      role,
      timers: [],
      listeners: new Set(),
      startedAt: at,
    };
    this.runs.set(run.meta.id, run);
    return run;
  }

  private sourceOf(role: RecordingRole): Source {
    const r = this.rec.runs[role];
    return { events: r.events, report: r.report, markdown: r.markdown, status: r.meta.status, error: r.meta.error, config: r.meta.config };
  }

  private startFromRequest(req: StartRunRequest): RunMeta {
    if (!req.sample) throw new Error("The demo replays recorded runs of the samples: pick a sample instead of uploading files.");
    if (req.sample !== "petstore" && req.sample !== "docs") throw new Error(`Unknown sample ${req.sample}`);
    if (req.mode === "claude" || (req.mode === "ollama" && req.leadProvider === "claude")) throw new Error(CLAUDE_MESSAGE);
    const gpuSplit = req.mode === "ollama" && req.sample === "petstore" && (req.workerEndpoints?.length ?? 0) > 1;
    const role: RecordingRole = gpuSplit ? "petstore-gpu" : `${req.sample}-${req.mode === "ollama" ? "ollama" : req.mode === "simulate" ? "simulate" : "diff"}`;
    const source = this.sourceOf(role);
    this.noteModels({ workerModel: req.workerModel, leadModel: req.leadModel }, source.config);
    const names = req.sample === "petstore" ? ["petstore-v1.yaml", "petstore-v2.yaml"] : ["docs-v1.md", "docs-v2.md"];
    return this.startReplay(source, { source: "dashboard", baselineName: names[0]!, candidateName: names[1]! }, role);
  }

  /** The recordings fix the models; say so when the visitor asked for others. */
  private noteModels(asked: Partial<RunConfig>, recorded: RunConfig) {
    if (recorded.mode !== "ollama") return;
    const differs = (a: string | undefined, b: string | undefined) => a && b && a !== b;
    if (differs(asked.workerModel, recorded.workerModel) || differs(asked.leadModel, recorded.leadModel)) {
      this.notice("info", "Replaying the closest recording", `This run was recorded with ${recorded.workerModel} workers and a ${recorded.leadModel} lead; the demo can't call other models.`);
    }
  }

  private startReplay(source: Source, init: Pick<RunMeta, "source" | "baselineName" | "candidateName"> & Partial<RunMeta>, role?: RecordingRole): RunMeta {
    const start = this.now();
    const run: LiveRun = {
      meta: {
        id: newRunId(start),
        createdAt: new Date(start).toISOString(),
        status: "running",
        config: source.config,
        summary: summarize([]),
        ...init,
      },
      events: [],
      role,
      timers: [],
      listeners: new Set(),
      startedAt: start,
    };
    this.runs.set(run.meta.id, run);

    const events = source.events;
    const t0 = events[0]?.t ?? 0;
    const total = (events.at(-1)?.t ?? t0) - t0;
    const speed = Math.max(1, total / this.replayMs);
    if (speed > 1.5) this.notice("info", `Replaying a recorded run at ${Math.round(speed)}× speed`, "Timings in this run are compressed by the same factor.");
    for (const recorded of events) {
      const offset = Math.round((recorded.t - t0) / speed);
      const timer = setTimeout(() => {
        const e = { ...recorded, t: start + offset } as RunEvent;
        if ("durationMs" in e && typeof e.durationMs === "number") (e as { durationMs: number }).durationMs = Math.round(e.durationMs / speed);
        this.emit(run, e);
        if (e.type === "run-end") this.finish(run, source);
      }, offset);
      run.timers.push(timer);
    }
    return this.metaOf(run);
  }

  private emit(run: LiveRun, e: RunEvent) {
    run.events.push(e);
    for (const l of run.listeners) l(e);
  }

  private finish(run: LiveRun, source: Source) {
    run.timers = [];
    run.meta = {
      ...run.meta,
      status: source.status,
      ...(source.error ? { error: source.error } : {}),
      summary: summarize(run.events),
    };
    run.report = { ...source.report, generatedAt: new Date(this.now()).toISOString(), ...(run.meta.retryOf && { retryOf: run.meta.retryOf }) };
    run.markdown = source.markdown;
    this.onRunFinished(run);
  }

  private cancel(run: LiveRun): boolean {
    if (run.meta.status !== "running") return false;
    for (const t of run.timers) clearTimeout(t);
    run.timers = [];
    const now = this.now();
    this.emit(run, { type: "run-end", durationMs: now - run.startedAt, failedUnits: 0, stopped: "cancelled", seq: (run.events.at(-1)?.seq ?? 0) + 1, t: now } as RunEvent);
    run.meta = { ...run.meta, status: "cancelled", summary: summarize(run.events) };
    return true;
  }

  private retryInfo(run: LiveRun): RetryInfo {
    const report = run.report;
    return {
      retryable: run.meta.status !== "running",
      analyses: report ? Object.keys(report.analyses).length : 0,
      failedUnits: report?.failedUnits.length ?? 0,
      notRunUnits: report?.notRunUnits.length ?? 0,
      units: report?.diff.units.length ?? run.meta.summary.units,
      leadError: report?.synthesisError ?? (report?.stopped ? report.stopped.error : undefined),
      hasRiskReport: Boolean(report?.riskReport),
    };
  }

  private retry(original: LiveRun, body: { scope?: string; config?: Partial<RunConfig> }): RunMeta {
    const scope = body.scope;
    if (scope !== "lead" && scope !== "failed" && scope !== "all") throw new Error('scope must be "lead", "failed" or "all"');
    if (original.meta.status === "running") throw new Error("This run is still running: cancel it or wait until it finishes");
    const config: RunConfig = { ...original.meta.config, ...body.config };
    const report = original.report;
    if (scope !== "all") {
      if (config.mode === "diff") throw new Error("Choose an agent provider: rerunning the lead needs agents");
      if (!report) throw new Error("The original run has no report to reuse: rerun everything instead");
      if (Object.keys(report.analyses).length === 0) {
        throw new Error("The original run has no worker analyses to reuse (it ran without agents, or every worker failed): rerun everything or the failed workers instead");
      }
    }
    if (config.mode === "claude" || (config.mode === "ollama" && config.leadProvider === "claude")) throw new Error(CLAUDE_MESSAGE);

    let source: Source;
    let role: RecordingRole | undefined;
    if (original.role === "lead-failed" && scope !== "all") {
      // The real rerun: same worker analyses, qwen3.5:4b as the lead.
      role = "lead-rerun";
      source = this.sourceOf(role);
    } else {
      role = this.templateFor(original, config.mode);
      source = scope === "all" ? this.sourceOf(role) : reuseAnalyses(this.rec.runs[role], original.meta.id, report!, scope);
      if (scope !== "all") role = undefined;
    }
    this.noteModels(config, source.config);

    const origin = original.meta.origin;
    const meta = this.startReplay(
      source,
      {
        source: origin ? "tracker" : "dashboard",
        baselineName: original.meta.baselineName,
        candidateName: original.meta.candidateName,
        ...(origin && { origin: { ...origin, trigger: origin.trigger === "compare" ? "compare" : "retry" } }),
        retryOf: original.meta.id,
        retryScope: scope,
      },
      role,
    );
    original.meta = { ...original.meta, retriedBy: [...(original.meta.retriedBy ?? []), meta.id] };
    return meta;
  }

  /** The recording to replay for this run with `mode`: its own if it succeeded, else the sample's. */
  private templateFor(run: LiveRun, mode: RunConfig["mode"]): RecordingRole {
    const own = run.role && this.rec.runs[run.role];
    if (own && run.role !== "lead-failed" && own.meta.config.mode === mode && own.meta.status === "done") return run.role!;
    const format = run.events.find((e) => e.type === "run-start")?.format ?? run.report?.diff.format;
    const role: RecordingRole = `${format === "markdown" ? "docs" : "petstore"}-${mode === "ollama" ? "ollama" : mode === "simulate" ? "simulate" : "diff"}`;
    const units = (r: { diff: { units: { id: string }[] } } | undefined) => (r?.diff.units.map((u) => u.id).sort() ?? []).join("\n");
    if (run.report && units(run.report) !== units(this.rec.runs[role].report)) {
      throw new Error(`The demo has no ${mode} recording of this comparison. Try another provider.`);
    }
    return role;
  }

  // ---- tracked APIs ------------------------------------------------------------

  private loadTrackedApi(now: number) {
    const recorded = structuredClone(this.rec.api);
    const [v1, v2, ...later] = recorded.versions;
    if (!v1 || !v2) return;
    const at1 = now - 6 * DAY;
    const at2 = now - 2 * DAY + 4 * HOUR;
    v1.fetchedAt = new Date(at1).toISOString();
    v2.fetchedAt = new Date(at2).toISOString();
    const [c1, c2] = recorded.checks;
    const checks = [
      { ...c1!, at: v1.fetchedAt },
      { ...c2!, at: v2.fetchedAt },
    ];
    const tracker1 = this.preload("tracker-1", at2);
    const api: TrackedApi = {
      ...recorded.api,
      createdAt: v1.fetchedAt,
      lastCheckedAt: v2.fetchedAt,
      lastOutcome: "changed",
      nextCheckAt: new Date(now + 40 * 60_000).toISOString(),
    };
    v2.runId = tracker1.meta.id;
    this.apis.set(api.id, {
      api,
      versions: [v1, v2],
      checks,
      pending: later,
      snapshots: new Map(Object.entries(recorded.snapshots)),
      operations: new Map(Object.entries(recorded.operations)),
    });
  }

  private requireApi(id: string): ApiState {
    const state = this.apis.get(id);
    if (!state) throw new HttpError(404, `No tracked API ${id}`);
    return state;
  }

  private listApis() {
    return [...this.apis.values()]
      .map(({ api, versions }) => ({ ...redactApi(api), versions: versions.length, latest: versions.at(-1) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private apiDetail(state: ApiState) {
    return { api: redactApi(state.api), versions: [...state.versions].reverse(), checks: [...state.checks].reverse() };
  }

  /** Any URL "resolves" to the recorded Petstore spec: the demo can't fetch. */
  private discover(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(422, `"${url}" is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new HttpError(422, "Only http(s) URLs can be tracked");
    const latest = this.rec.api.versions.at(-1)!;
    const specUrl = /\.(json|ya?ml)$/i.test(parsed.pathname) ? parsed.href : `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}/openapi.json`;
    this.notice("info", "Demo: no network", "Every URL resolves to the recorded Petstore spec.");
    return { url: specUrl, summary: latest.summary, hash: latest.hash };
  }

  private addApi(body: { name?: string; url?: string; headers?: Record<string, string>; intervalMinutes?: number; agents?: Partial<RunConfig> }) {
    const found = this.discover(String(body.url ?? ""));
    const latest = this.rec.api.versions.at(-1)!;
    const name = body.name?.trim() || found.summary.title || new URL(found.url).host;
    const id = `${slug(name)}-${randomHex(2)}`;
    const now = new Date(this.now()).toISOString();
    const snapshot: Snapshot = { id: `0001-${latest.hash.slice(0, 12)}`, seq: 1, hash: latest.hash, fetchedAt: now, url: found.url, summary: latest.summary };
    const api: TrackedApi = {
      id,
      name,
      url: found.url,
      headers: body.headers ?? {},
      intervalMinutes: body.intervalMinutes ?? 60,
      enabled: true,
      agents: { ...DEFAULT_AGENTS, ...body.agents },
      createdAt: now,
      lastCheckedAt: now,
      lastOutcome: "baseline",
      ...(body.intervalMinutes !== 0 && { nextCheckAt: new Date(this.now() + (body.intervalMinutes ?? 60) * 60_000).toISOString() }),
    };
    const state: ApiState = {
      api,
      versions: [snapshot],
      checks: [{ at: now, outcome: "baseline", durationMs: 12, trigger: "created", status: 200, snapshotId: snapshot.id }],
      pending: [],
      snapshots: new Map([[snapshot.id, this.rec.api.snapshots[latest.id]]]),
      operations: new Map([[snapshot.id, this.rec.api.operations[latest.id] ?? []]]),
    };
    this.apis.set(id, state);
    return this.apiDetail(state);
  }

  private updateApi(state: ApiState, patch: Omit<Partial<TrackedApi>, "agents"> & { agents?: Partial<RunConfig> }) {
    const { agents, headers, ...rest } = patch;
    state.api = {
      ...state.api,
      ...pick(rest, ["name", "url", "intervalMinutes", "enabled"]),
      ...(headers && { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v === REDACTED ? (state.api.headers[k] ?? "") : v])) }),
      ...(agents && { agents: { ...DEFAULT_AGENTS, ...agents } }),
    };
    return this.apiDetail(state);
  }

  private check(state: ApiState, trigger: string): CheckRecord {
    const now = this.now();
    const at = new Date(now).toISOString();
    const next = state.pending.shift();
    state.api = { ...state.api, lastCheckedAt: at, nextCheckAt: new Date(now + state.api.intervalMinutes * 60_000).toISOString() };
    if (!next) {
      const record: CheckRecord = { at, outcome: "unchanged", durationMs: 9 + Math.round(Math.random() * 10), trigger, status: 200, snapshotId: state.versions.at(-1)?.id };
      state.checks.push(record);
      state.api.lastOutcome = "unchanged";
      return record;
    }
    const previous = state.versions.at(-1)!;
    const snapshot: Snapshot = { ...next, fetchedAt: at, previousId: previous.id };
    state.versions.push(snapshot);
    const origin: RunOrigin = { apiId: state.api.id, apiName: state.api.name, fromSnapshot: previous.id, toSnapshot: snapshot.id, trigger: "check" };
    const meta = this.startReplay(this.sourceOf("tracker-2"), { source: "tracker", origin, baselineName: specName(state.api, previous), candidateName: specName(state.api, snapshot) }, "tracker-2");
    snapshot.runId = meta.id;
    const record: CheckRecord = { at, outcome: "changed", durationMs: 14, trigger, status: 200, snapshotId: snapshot.id, runId: meta.id };
    state.checks.push(record);
    state.api.lastOutcome = "changed";
    this.notice("info", `New version: ${state.api.name} v${snapshot.summary.version}`, "A report run started against the previous version.");
    return record;
  }

  private compareVersions(state: ApiState, from: string, to: string): RunMeta {
    const a = state.versions.find((v) => v.id === from);
    const b = state.versions.find((v) => v.id === to);
    if (!a || !b) throw new HttpError(404, "No such snapshot");
    const role: RecordingRole | undefined = state.api.id === this.rec.api.api.id ? ({ "1>2": "petstore-ollama", "2>3": "tracker-2" } as const)[`${a.seq}>${b.seq}` as "1>2"] : undefined;
    if (!role) throw new Error("The demo has recordings for v1 → v2 and v2 → v3 of Petstore only.");
    const origin: RunOrigin = { apiId: state.api.id, apiName: state.api.name, fromSnapshot: a.id, toSnapshot: b.id, trigger: "compare" };
    return this.startReplay(this.sourceOf(role), { source: "tracker", origin, baselineName: specName(state.api, a), candidateName: specName(state.api, b) }, role);
  }

  // ---- applications --------------------------------------------------------------

  private requireApp(id: string): Application {
    const app = this.apps.find((a) => a.id === id);
    if (!app) throw new HttpError(404, `No application ${id}`);
    return app;
  }

  private listApps() {
    return this.apps.map((app) => {
      const impacts = this.impactsFor({ appId: app.id });
      return {
        ...app,
        impacts: impacts.length,
        breaking30d: impacts.filter((i) => Date.parse(i.at) > this.now() - 30 * DAY).reduce((n, i) => n + i.counts.breaking, 0),
        lastImpact: impacts[0],
      };
    });
  }

  private appDetail(app: Application) {
    return { app, impacts: this.impactsFor({ appId: app.id }).slice(0, 200) };
  }

  private createApp(input: Partial<Application>) {
    if (!input.name?.trim()) throw new Error("Application name is required");
    this.validateDependencies(input.dependencies ?? []);
    this.validateChannelIds(input.channelIds ?? []);
    const app: Application = {
      id: `${slug(input.name)}-${randomHex(2)}`,
      name: input.name.trim(),
      description: input.description,
      owner: input.owner,
      contact: input.contact,
      dependencies: normalizeDependencies(input.dependencies ?? []),
      channelIds: input.channelIds ?? [],
      minSeverity: input.minSeverity ?? "breaking",
      createdAt: new Date(this.now()).toISOString(),
    };
    this.apps.push(app);
    this.backfill(app);
    return this.appDetail(app);
  }

  private updateApp(app: Application, patch: Partial<Application>) {
    if (patch.dependencies) this.validateDependencies(patch.dependencies);
    if (patch.channelIds) this.validateChannelIds(patch.channelIds);
    Object.assign(app, {
      ...pick(patch, ["name", "description", "owner", "contact", "channelIds", "minSeverity"]),
      ...(patch.name && { name: patch.name.trim() }),
      ...(patch.dependencies && { dependencies: normalizeDependencies(patch.dependencies) }),
    });
    if (patch.dependencies) this.backfill(app);
    return this.appDetail(app);
  }

  private validateDependencies(deps: Dependency[]) {
    for (const d of deps) {
      if (!this.apis.has(d.apiId)) throw new Error(`Unknown tracked API "${d.apiId}"`);
      if (d.operations !== "all") {
        const bad = d.operations.filter((o) => !operationKey(o));
        if (bad.length) throw new Error(`Not an operation (expected "METHOD /path"): ${bad.join(", ")}`);
      }
    }
  }

  private validateChannelIds(ids: string[]) {
    const unknown = ids.filter((id) => !this.channels.some((c) => c.id === id));
    if (unknown.length) throw new Error(`Unknown channel ${unknown.join(", ")}`);
  }

  private backfill(app: Application): number {
    for (const [key, impact] of this.impacts) if (impact.appId === app.id) this.impacts.delete(key);
    let count = 0;
    for (const dep of app.dependencies) {
      for (const version of this.apis.get(dep.apiId)?.versions ?? []) {
        const run = version.runId ? this.runs.get(version.runId) : undefined;
        if (!run?.report || !run.meta.origin || run.meta.origin.trigger === "compare") continue;
        const impact = this.impactFor(app, run);
        if (impact) {
          this.impacts.set(impact.id, impact);
          count++;
        }
      }
    }
    return count;
  }

  private impactFor(app: Application, run: LiveRun): ImpactRecord | undefined {
    const origin = run.meta.origin!;
    const history = this.apis.get(origin.apiId)?.versions ?? [];
    const ref = (id: string): VersionRef => {
      const v = history.find((h) => h.id === id);
      return { id, seq: v?.seq ?? Number(id.split("-")[0]), version: v?.summary.version };
    };
    return computeImpact(app, run.report!, {
      runId: run.meta.id,
      at: run.meta.createdAt,
      apiId: origin.apiId,
      apiName: origin.apiName,
      from: ref(origin.fromSnapshot),
      to: ref(origin.toSnapshot),
    });
  }

  private impactsFor(filter: { sinceDays?: number; appId?: string; apiId?: string; minSeverity?: Severity }): ImpactRecord[] {
    const since = filter.sinceDays ? this.now() - filter.sinceDays * DAY : 0;
    return [...this.impacts.values()]
      .filter((i) => (!filter.appId || i.appId === filter.appId) && (!filter.apiId || i.apiId === filter.apiId) && Date.parse(i.at) >= since)
      .filter((i) => !filter.minSeverity || meetsSeverity(i, filter.minSeverity))
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  private applicationsForRun(run: LiveRun) {
    if (!run.meta.origin || !run.report) return undefined;
    const apiId = run.meta.origin.apiId;
    const summaries = [];
    for (const app of this.apps.filter((a) => a.dependencies.some((d) => d.apiId === apiId))) {
      const impact = this.impactFor(app, run);
      if (impact) summaries.push({ id: app.id, name: app.name, owner: app.owner, unitIds: [...new Set(impact.changes.map((c) => c.unitId))], counts: impact.counts });
    }
    return summaries;
  }

  /** Mirrors AppService.onRunFinished: impacts for new versions, notifications above each app's threshold. */
  private onRunFinished(run: LiveRun) {
    const origin = run.meta.origin;
    if (!origin || origin.trigger === "compare" || !run.report) return;
    const isRetry = origin.trigger === "retry";
    if (isRetry && run.meta.retryOf) {
      for (const [key, impact] of this.impacts) if (impact.runId === run.meta.retryOf) this.impacts.delete(key);
      const version = run.meta.status === "done" ? this.apis.get(origin.apiId)?.versions.find((v) => v.id === origin.toSnapshot) : undefined;
      if (version) version.runId = run.meta.id;
    }
    for (const app of this.apps.filter((a) => a.dependencies.some((d) => d.apiId === origin.apiId))) {
      const impact = this.impactFor(app, run);
      if (!impact) continue;
      this.impacts.set(impact.id, impact);
      if (isRetry || !meetsSeverity(impact, app.minSeverity)) continue;
      for (const channel of this.channels.filter((c) => c.enabled && app.channelIds.includes(c.id))) this.deliver(channel, { app, impact });
    }
  }

  // ---- channels ----------------------------------------------------------------

  private requireChannel(id: string): Channel {
    const channel = this.channels.find((c) => c.id === id);
    if (!channel) throw new HttpError(404, `No channel ${id}`);
    return channel;
  }

  private createChannel(input: Partial<Channel>) {
    const channel = { ...input, enabled: input.enabled ?? true } as Channel;
    validateChannel(channel);
    channel.id = `${slug(channel.name)}-${randomHex(2)}`;
    channel.createdAt = new Date(this.now()).toISOString();
    this.channels.push(channel);
    return redactChannel(channel);
  }

  private updateChannel(channel: Channel, patch: Partial<Channel>) {
    const keep = <T>(next: T | undefined, current: T) => (next === undefined || next === REDACTED ? current : next);
    const updated: Channel = {
      ...channel,
      ...patch,
      id: channel.id,
      url: keep(patch.url, channel.url),
      secret: keep(patch.secret, channel.secret),
      token: keep(patch.token, channel.token),
      headers: patch.headers ? Object.fromEntries(Object.entries(patch.headers).map(([k, v]) => [k, v === REDACTED ? (channel.headers?.[k] ?? "") : v])) : channel.headers,
    };
    validateChannel(updated);
    Object.assign(channel, updated);
    return redactChannel(channel);
  }

  /** Records a delivery as if the receiver accepted it; nothing leaves the browser. */
  private deliver(channel: Channel, event: { test: true } | { app: Application; impact: ImpactRecord }): Delivery {
    const delivery: Delivery = {
      id: randomHex(6),
      at: new Date(this.now()).toISOString(),
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      test: "test" in event,
      ...("app" in event && { appId: event.app.id, impactId: event.impact.id }),
      ok: true,
      status: channel.type === "github" ? 204 : channel.type === "teams" ? 202 : 200,
      attempts: 1,
      durationMs: 90 + Math.round(Math.random() * 220),
    };
    this.deliveries.push(delivery);
    if ("app" in event) {
      const recorded = this.rec.notifications[`${event.app.id}/${channel.id}`];
      const payload = recorded && event.impact.runId && { url: recorded.url, body: recorded.body.split(this.rec.runPlaceholder).join(event.impact.runId) };
      this.notice("notification", `${channel.name} notified: ${event.app.name}`, `${event.impact.counts.breaking} breaking, ${event.impact.counts.warning} warning in ${event.impact.apiName} v${event.impact.to.version}`, payload || undefined);
    } else {
      this.notice("notification", `Test message to ${channel.name}`, "Recorded as delivered; the demo sends nothing.");
    }
    return delivery;
  }

  private notice(kind: DemoNotice["kind"], title: string, detail?: string, payload?: DemoNotice["payload"]) {
    const n: DemoNotice = { id: ++this.noticeSeq, kind, title, detail, payload };
    for (const l of this.noticeListeners) l(n);
  }
}

// ---- helpers -------------------------------------------------------------------

/**
 * A lead-only (or failed-workers) rerun built from a recording: the original
 * run's analyses are reused, and the recording supplies the lead's turns.
 */
export function reuseAnalyses(template: RecordedRun, fromRun: string, original: ComparisonReport, scope: "lead" | "failed"): Source {
  const events = template.events;
  const start = events.find((e) => e.type === "run-start")!;
  const t0 = start.t;
  const leadFrom = events.findIndex((e) => e.type === "synthesis-start");
  const leadTo = events.findIndex((e) => e.type === "run-end");
  const missing = [...new Set([...original.failedUnits.map((f) => f.unitId), ...original.notRunUnits])];
  const out: RunEvent[] = [start];
  for (const [unitId, analysis] of Object.entries(original.analyses)) out.push({ type: "unit-reused", unitId, analysis, fromRun, seq: 0, t: t0 } as RunEvent);
  let workEnd = t0;
  for (const unitId of missing) {
    if (scope === "lead") {
      out.push({ type: "unit-skipped", unitId, reason: "not-rerun", seq: 0, t: t0 } as RunEvent);
      continue;
    }
    for (const e of events.slice(0, leadFrom < 0 ? leadTo : leadFrom)) {
      if ("unitId" in e && e.unitId === unitId && !("question" in e && e.question)) {
        out.push(e);
        workEnd = Math.max(workEnd, e.t);
      }
    }
  }
  const lead = leadFrom < 0 ? [] : events.slice(leadFrom, leadTo);
  const shift = lead.length ? workEnd + 20 - lead[0]!.t : 0;
  for (const e of lead) out.push({ ...e, t: e.t + shift });
  const last = out.at(-1)!.t;
  const failedUnits =
    scope === "lead"
      ? original.failedUnits.map((f) => ({ unitId: f.unitId, error: `Not re-run: ${f.error}` }))
      : template.report.failedUnits.filter((f) => missing.includes(f.unitId));
  out.push({ type: "run-end", durationMs: last - t0, failedUnits: failedUnits.length, seq: 0, t: last } as RunEvent);
  out.forEach((e, i) => (e.seq = i + 1));

  const analyses = { ...original.analyses };
  if (scope === "failed") for (const id of missing) if (template.report.analyses[id]) analyses[id] = template.report.analyses[id]!;
  for (const inv of template.report.investigations) analyses[inv.unitId] = inv.analysis;
  return {
    events: out,
    report: { ...template.report, analyses, reusedUnits: Object.keys(original.analyses), failedUnits, notRunUnits: [] },
    markdown: template.markdown,
    status: template.report.synthesisError ? "failed" : "done",
    error: template.report.synthesisError,
    config: template.meta.config,
  };
}

function newRunId(now: number): string {
  return `${now.toString(36)}-${randomHex(3)}`;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]])) as Partial<Pick<T, K>>;
}

function specName(api: TrackedApi, v: Snapshot): string {
  return `${slug(api.name)}@${v.summary.version ?? "?"}#${v.seq}.json`;
}

function redactApi(api: TrackedApi): TrackedApi {
  return { ...api, headers: Object.fromEntries(Object.keys(api.headers).map((k) => [k, REDACTED])) };
}

function normalizeDependencies(deps: Dependency[]): Dependency[] {
  const merged = new Map<string, Dependency>();
  for (const d of deps) {
    const ops = d.operations === "all" ? "all" : [...new Set(d.operations.map((o) => operationKey(o)!))].sort();
    merged.set(d.apiId, { apiId: d.apiId, operations: ops, ...(d.note && { note: d.note }) });
  }
  return [...merged.values()];
}

function validateChannel(c: Channel) {
  if (!c.name?.trim()) throw new Error("Channel name is required");
  let url: URL;
  try {
    url = new URL(c.url);
  } catch {
    throw new Error(`"${c.url}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Channel URLs must be http(s)");
  if (["slack", "teams", "discord", "github"].includes(c.type) && url.protocol !== "https:") throw new Error(`${c.type} URLs must use https`);
  if ((c.type === "github" || c.type === "gitlab") && !c.token) throw new Error(`${c.type} channels need a token`);
}

function redactChannel(c: Channel): Channel {
  let shown = REDACTED;
  try {
    shown = `${new URL(c.url).origin}/${REDACTED}`;
  } catch {
    // not a URL
  }
  return {
    ...c,
    url: shown,
    ...(c.secret && { secret: REDACTED }),
    ...(c.token && { token: REDACTED }),
    ...(c.headers && { headers: Object.fromEntries(Object.keys(c.headers).map((k) => [k, REDACTED])) }),
  };
}

