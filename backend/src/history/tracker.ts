import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { RunConfig, RunManager } from "../server/runs.js";
import { summarizeMonitoring, type MonitoringReport } from "./monitoring.js";
import { discoverSpec, fetchSpec, SpecFetchError, type SpecSummary } from "./spec.js";

// Tracks live APIs: fetches each one's spec on a schedule (or on demand),
// keeps a snapshot per distinct version, and starts a comparison run against
// the previous snapshot whenever the spec changes. Together that is the API's
// change history.
//
// On disk, under the apis dir:
//   <apiId>/api.json          tracked API settings (contains request headers: mode 600)
//   <apiId>/versions.json     snapshot metadata, oldest first
//   <apiId>/snapshots/<id>.json   canonical spec of each version
//   <apiId>/checks.jsonl      one line per check

export interface TrackedApi {
  id: string;
  name: string;
  /** Spec URL (resolved by discovery when a base URL was given). */
  url: string;
  /** Sent with every fetch, e.g. Authorization. Redacted in API responses. */
  headers: Record<string, string>;
  /** 0 = only checked on demand. */
  intervalMinutes: number;
  enabled: boolean;
  /** Agents used for the automatic report when a new version appears. */
  agents: RunConfig;
  createdAt: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastOutcome?: CheckOutcome;
  lastError?: string;
}

export interface Snapshot {
  id: string;
  seq: number;
  hash: string;
  fetchedAt: string;
  url: string;
  summary: SpecSummary;
  /** Snapshot this one was compared with, and the run holding that report. */
  previousId?: string;
  runId?: string;
  runError?: string;
}

export type CheckOutcome = "baseline" | "unchanged" | "changed" | "error";

export interface CheckRecord {
  at: string;
  outcome: CheckOutcome;
  durationMs: number;
  /** "schedule", "manual" or "created". */
  trigger: string;
  status?: number;
  snapshotId?: string;
  runId?: string;
  error?: string;
}

export interface NewApiInput {
  name?: string;
  url: string;
  headers?: Record<string, string>;
  intervalMinutes?: number;
  agents?: Partial<RunConfig>;
}

export type ApiPatch = Partial<Pick<TrackedApi, "name" | "url" | "headers" | "intervalMinutes" | "enabled">> & { agents?: Partial<RunConfig> };

export const REDACTED = "••••••";
const DEFAULT_AGENTS: RunConfig = { mode: "diff", concurrency: 4, skipInfo: false };

interface ApiState {
  api: TrackedApi;
  versions: Snapshot[];
  checking?: Promise<CheckRecord>;
}

export interface ApiTrackerOptions {
  dir: string;
  runs: RunManager;
  /** Injected for tests. */
  now?: () => number;
}

export class ApiTracker {
  private readonly apis = new Map<string, ApiState>();
  private timer?: NodeJS.Timeout;
  private tickMs?: number;
  private readonly now: () => number;

  constructor(private readonly options: ApiTrackerOptions) {
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<this> {
    if (!existsSync(this.options.dir)) return this;
    for (const entry of await readdir(this.options.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const api = JSON.parse(await readFile(join(this.options.dir, entry.name, "api.json"), "utf8")) as TrackedApi;
        const versionsFile = join(this.options.dir, entry.name, "versions.json");
        const versions = existsSync(versionsFile) ? (JSON.parse(await readFile(versionsFile, "utf8")) as Snapshot[]) : [];
        this.apis.set(api.id, { api, versions });
      } catch {
        // not a tracked API directory
      }
    }
    return this;
  }

  list() {
    return [...this.apis.values()]
      .map(({ api, versions }) => ({ ...redact(api), versions: versions.length, latest: versions.at(-1) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async detail(id: string, checkLimit = 100) {
    const state = this.require(id);
    return { api: redact(state.api), versions: [...state.versions].reverse(), checks: await this.checks(id, checkLimit) };
  }

  /** Registers an API and takes its first snapshot (the baseline). */
  async add(input: NewApiInput) {
    const headers = input.headers ?? {};
    this.options.runs.validateConfig({ ...DEFAULT_AGENTS, ...input.agents });
    // Accept a base URL: find the spec before saving anything.
    const found = await discoverSpec(input.url, headers);
    const id = `${slug(input.name || found.summary.title || new URL(found.url).host)}-${randomBytes(2).toString("hex")}`;
    const api: TrackedApi = {
      id,
      name: input.name?.trim() || found.summary.title || new URL(found.url).host,
      url: found.url,
      headers,
      intervalMinutes: Math.max(0, input.intervalMinutes ?? 60),
      enabled: true,
      agents: { ...DEFAULT_AGENTS, ...input.agents },
      createdAt: new Date(this.now()).toISOString(),
    };
    this.apis.set(id, { api, versions: [] });
    await mkdir(join(this.apiDir(id), "snapshots"), { recursive: true });
    await this.saveApi(id);
    await this.check(id, "created");
    return this.detail(id);
  }

  async update(id: string, patch: ApiPatch) {
    const state = this.require(id);
    const { agents, headers, ...rest } = patch;
    // The agents object replaces the stored one, so cleared fields (a lead back to "same", a model back to default) really clear.
    if (agents) this.options.runs.validateConfig({ ...DEFAULT_AGENTS, ...agents });
    Object.assign(state.api, rest);
    if (agents) state.api.agents = { ...DEFAULT_AGENTS, ...agents };
    if (headers) {
      // A redacted value coming back from the UI means "keep the stored one".
      state.api.headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, v === REDACTED ? (state.api.headers[k] ?? "") : v]),
      );
    }
    state.api.nextCheckAt = this.nextCheck(state.api);
    await this.saveApi(id);
    return this.detail(id);
  }

  async remove(id: string) {
    this.require(id);
    this.apis.delete(id);
    await rm(this.apiDir(id), { recursive: true, force: true });
  }

  /** Fetches the spec now. Concurrent calls for the same API share one check. */
  check(id: string, trigger = "manual"): Promise<CheckRecord> {
    const state = this.require(id);
    if (!state.checking) {
      state.checking = this.runCheck(state, trigger).finally(() => (state.checking = undefined));
    }
    return state.checking;
  }

  /** Starts a comparison run between any two snapshots of an API. */
  async compare(id: string, fromId: string, toId: string) {
    const state = this.require(id);
    const from = state.versions.find((v) => v.id === fromId);
    const to = state.versions.find((v) => v.id === toId);
    if (!from || !to) throw new Error("Unknown snapshot");
    return this.startRun(state, from, to, "compare");
  }

  /** On-disk path of a snapshot's canonical spec (for parsing it as an OpenAPI file). */
  snapshotPath(id: string, snapshotId: string): string | undefined {
    const state = this.require(id);
    if (!state.versions.some((v) => v.id === snapshotId)) return undefined;
    return join(this.apiDir(id), "snapshots", `${snapshotId}.json`);
  }

  /** Every snapshot with a report, oldest first: the change history used to backfill impacts. */
  history(id: string): Snapshot[] {
    return [...this.require(id).versions];
  }

  /** Points a version at a newer report for the same change (a successful rerun). */
  async relinkRun(id: string, snapshotId: string, runId: string): Promise<void> {
    const state = this.apis.get(id);
    const version = state?.versions.find((v) => v.id === snapshotId);
    if (!state || !version) return;
    version.runId = runId;
    delete version.runError;
    await this.saveVersions(id);
  }

  has(id: string): boolean {
    return this.apis.has(id);
  }

  async snapshotContent(id: string, snapshotId: string): Promise<string | undefined> {
    const state = this.require(id);
    if (!state.versions.some((v) => v.id === snapshotId)) return undefined;
    return readFile(join(this.apiDir(id), "snapshots", `${snapshotId}.json`), "utf8");
  }

  async checks(id: string, limit = 100): Promise<CheckRecord[]> {
    const file = join(this.apiDir(id), "checks.jsonl");
    if (!existsSync(file)) return [];
    const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as CheckRecord);
  }

  /** Check history and schedule across every tracked API (the Monitoring page). */
  async monitoring(days = 7, limit = 200): Promise<MonitoringReport> {
    const apis = await Promise.all(
      [...this.apis.values()].map(async ({ api, versions }) => ({ api, versions: versions.length, checks: await this.checks(api.id, Number.MAX_SAFE_INTEGER) })),
    );
    return summarizeMonitoring(apis, { now: this.now(), days, limit, scheduler: { running: this.timer !== undefined, tickMs: this.tickMs } });
  }

  /** Checks every enabled API whose interval has elapsed. */
  async tick(): Promise<CheckRecord[]> {
    const due = [...this.apis.values()].filter(({ api }) => {
      if (!api.enabled || api.intervalMinutes <= 0) return false;
      return !api.nextCheckAt || Date.parse(api.nextCheckAt) <= this.now();
    });
    return Promise.all(due.map(({ api }) => this.check(api.id, "schedule")));
  }

  startScheduler(everyMs = 30_000) {
    this.stopScheduler();
    const run = () => void this.tick().catch(() => {});
    this.timer = setInterval(run, everyMs);
    this.tickMs = everyMs;
    this.timer.unref();
    run();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tickMs = undefined;
  }

  // ---- internals -------------------------------------------------------------

  private async runCheck(state: ApiState, trigger: string): Promise<CheckRecord> {
    const { api } = state;
    const started = this.now();
    let record: CheckRecord;
    try {
      const spec = await fetchSpec(api.url, api.headers);
      const latest = state.versions.at(-1);
      if (latest && latest.hash === spec.hash) {
        record = { at: iso(started), outcome: "unchanged", durationMs: this.now() - started, trigger, status: spec.status, snapshotId: latest.id };
      } else {
        const seq = (latest?.seq ?? 0) + 1;
        const snapshot: Snapshot = {
          id: `${String(seq).padStart(4, "0")}-${spec.hash.slice(0, 12)}`,
          seq,
          hash: spec.hash,
          fetchedAt: iso(started),
          url: spec.url,
          summary: spec.summary,
          previousId: latest?.id,
        };
        await writeFile(join(this.apiDir(api.id), "snapshots", `${snapshot.id}.json`), spec.canonical);
        state.versions.push(snapshot);
        if (latest) {
          try {
            snapshot.runId = (await this.startRun(state, latest, snapshot, "check")).id;
          } catch (error) {
            snapshot.runError = (error as Error).message;
          }
        }
        await this.saveVersions(api.id);
        record = {
          at: iso(started),
          outcome: latest ? "changed" : "baseline",
          durationMs: this.now() - started,
          trigger,
          status: spec.status,
          snapshotId: snapshot.id,
          runId: snapshot.runId,
          error: snapshot.runError && `Spec changed but the report could not start: ${snapshot.runError}`,
        };
      }
      api.lastError = record.error;
    } catch (error) {
      const message = (error as Error).message;
      record = { at: iso(started), outcome: "error", durationMs: this.now() - started, trigger, error: message, status: error instanceof SpecFetchError ? error.status : undefined };
      api.lastError = message;
    }
    api.lastCheckedAt = record.at;
    api.lastOutcome = record.outcome;
    api.nextCheckAt = this.nextCheck(api);
    await appendFile(join(this.apiDir(api.id), "checks.jsonl"), `${JSON.stringify(record)}\n`);
    await this.saveApi(api.id);
    return record;
  }

  private async startRun(state: ApiState, from: Snapshot, to: Snapshot, trigger: "check" | "compare") {
    const dir = join(this.apiDir(state.api.id), "snapshots");
    const label = (s: Snapshot) => `${slug(state.api.name)}@${s.summary.version ?? "unversioned"}#${s.seq}.json`;
    return this.options.runs.start({
      baseline: { name: label(from), content: await readFile(join(dir, `${from.id}.json`), "utf8") },
      candidate: { name: label(to), content: await readFile(join(dir, `${to.id}.json`), "utf8") },
      config: state.api.agents,
      origin: { apiId: state.api.id, apiName: state.api.name, fromSnapshot: from.id, toSnapshot: to.id, trigger },
    });
  }

  private nextCheck(api: TrackedApi): string | undefined {
    if (!api.enabled || api.intervalMinutes <= 0) return undefined;
    const from = api.lastCheckedAt ? Date.parse(api.lastCheckedAt) : this.now();
    return iso(from + api.intervalMinutes * 60_000);
  }

  private require(id: string): ApiState {
    const state = this.apis.get(id);
    if (!state) throw new UnknownApiError(`No tracked API ${id}`);
    return state;
  }

  private apiDir(id: string) {
    return join(this.options.dir, id);
  }

  private async saveApi(id: string) {
    const file = join(this.apiDir(id), "api.json");
    await mkdir(this.apiDir(id), { recursive: true });
    await writeFile(file, JSON.stringify(this.require(id).api, null, 2), { mode: 0o600 });
    await chmod(file, 0o600); // headers may hold credentials
  }

  private async saveVersions(id: string) {
    await writeFile(join(this.apiDir(id), "versions.json"), JSON.stringify(this.require(id).versions, null, 2));
  }
}

export type { MonitoringApi, MonitoringCheck, MonitoringReport } from "./monitoring.js";

export class UnknownApiError extends Error {}

function redact(api: TrackedApi): TrackedApi {
  return { ...api, headers: Object.fromEntries(Object.keys(api.headers).map((k) => [k, REDACTED])) };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "api";
}

const iso = (ms: number) => new Date(ms).toISOString();
