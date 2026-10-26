import SwaggerParser from "@apidevtools/swagger-parser";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiTracker } from "../history/tracker.js";
import type { ComparisonReport } from "../orchestrator.js";
import { renderMarkdownReport, type AppImpactSummary } from "../report/markdown.js";
import type { RunManager, RunMeta } from "../server/runs.js";
import { normalizeDocument } from "../swagger/normalize.js";
import type { Severity } from "../types.js";
import { computeImpact, meetsSeverity, operationKey } from "./impact.js";
import { deliver, type DeliverOptions, type NotificationEvent } from "./notify.js";
import { type Application, type Channel, type ChannelType, type Delivery, type Dependency, type ImpactRecord, type VersionRef } from "./types.js";

// Applications, notification channels, impact records and deliveries.
// On disk (under --apps-dir):
//   applications.json   applications and their dependencies
//   channels.json       channels, including webhook URLs and tokens (mode 600)
//   impacts.jsonl       one impact per (run, application); later lines win
//   deliveries.jsonl    every notification attempt

export const REDACTED = "••••••";

export interface AppServiceOptions {
  dir: string;
  runs: RunManager;
  tracker: ApiTracker;
  /** Dashboard URL used for "Open report" links in notifications. */
  publicUrl?: string;
  deliverOptions?: DeliverOptions;
}

export interface NewApplication {
  name: string;
  description?: string;
  owner?: string;
  contact?: string;
  dependencies?: Dependency[];
  channelIds?: string[];
  minSeverity?: Severity;
}

export interface NewChannel {
  name: string;
  type: ChannelType;
  url: string;
  secret?: string;
  token?: string;
  ref?: string;
  eventType?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ReportFilter {
  sinceDays?: number;
  appId?: string;
  apiId?: string;
  minSeverity?: Severity;
}

export class AppService {
  private apps: Application[] = [];
  private channels: Channel[] = [];
  private impacts = new Map<string, ImpactRecord>();
  publicUrl?: string;

  constructor(private readonly options: AppServiceOptions) {
    this.publicUrl = options.publicUrl;
  }

  async init(): Promise<this> {
    await mkdir(this.options.dir, { recursive: true });
    this.apps = await this.readJson("applications.json", []);
    this.channels = await this.readJson("channels.json", []);
    for (const impact of await this.readJsonl<ImpactRecord>("impacts.jsonl")) this.impacts.set(impact.id, impact);
    this.options.runs.onRunFinished((meta, report) => this.onRunFinished(meta, report));
    return this;
  }

  // ---- applications -------------------------------------------------------

  listApps() {
    return this.apps.map((app) => {
      const impacts = this.impactsFor({ appId: app.id });
      return {
        ...app,
        impacts: impacts.length,
        breaking30d: impacts.filter((i) => Date.parse(i.at) > Date.now() - 30 * 86_400_000).reduce((n, i) => n + i.counts.breaking, 0),
        lastImpact: impacts[0],
      };
    });
  }

  appDetail(id: string) {
    const app = this.requireApp(id);
    return { app, impacts: this.impactsFor({ appId: id }).slice(0, 200) };
  }

  async createApp(input: NewApplication) {
    this.validateDependencies(input.dependencies ?? []);
    this.validateChannelIds(input.channelIds ?? []);
    const app: Application = {
      id: `${slug(input.name)}-${randomBytes(2).toString("hex")}`,
      name: input.name.trim(),
      description: input.description,
      owner: input.owner,
      contact: input.contact,
      dependencies: normalizeDependencies(input.dependencies ?? []),
      channelIds: input.channelIds ?? [],
      minSeverity: input.minSeverity ?? "breaking",
      createdAt: new Date().toISOString(),
    };
    this.apps.push(app);
    await this.saveApps();
    await this.backfill(app.id);
    return this.appDetail(app.id);
  }

  async updateApp(id: string, patch: Partial<NewApplication>) {
    const app = this.requireApp(id);
    if (patch.dependencies) this.validateDependencies(patch.dependencies);
    if (patch.channelIds) this.validateChannelIds(patch.channelIds);
    Object.assign(app, {
      ...patch,
      ...(patch.name && { name: patch.name.trim() }),
      ...(patch.dependencies && { dependencies: normalizeDependencies(patch.dependencies) }),
    });
    await this.saveApps();
    if (patch.dependencies) await this.backfill(id);
    return this.appDetail(id);
  }

  async deleteApp(id: string) {
    this.requireApp(id);
    this.apps = this.apps.filter((a) => a.id !== id);
    for (const [key, impact] of this.impacts) if (impact.appId === id) this.impacts.delete(key);
    await this.saveApps();
    await this.saveImpacts();
  }

  /**
   * Recomputes an application's impacts from the existing history of the APIs
   * it uses (no notifications), so a newly added application has a report at once.
   */
  async backfill(appId: string): Promise<number> {
    const app = this.requireApp(appId);
    for (const [key, impact] of this.impacts) if (impact.appId === appId) this.impacts.delete(key);
    let count = 0;
    for (const dep of app.dependencies) {
      if (!this.options.tracker.has(dep.apiId)) continue;
      for (const version of this.options.tracker.history(dep.apiId)) {
        if (!version.runId) continue;
        const meta = this.options.runs.get(version.runId);
        if (!meta?.origin || meta.origin.trigger === "compare") continue;
        const report = await this.options.runs.report(version.runId);
        if (!report) continue;
        const impact = this.impactFor(app, meta, report);
        if (impact) {
          this.impacts.set(impact.id, impact);
          count++;
        }
      }
    }
    await this.saveImpacts();
    return count;
  }

  async operations(apiId: string) {
    const latest = this.options.tracker.history(apiId).at(-1);
    if (!latest) return [];
    const path = this.options.tracker.snapshotPath(apiId, latest.id)!;
    const spec = normalizeDocument((await SwaggerParser.dereference(path)) as Record<string, any>);
    return Object.values(spec.operations)
      .map((op) => ({ key: op.key, method: op.method, path: op.path, summary: op.summary, deprecated: op.deprecated }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }

  /**
   * Applications affected by a run, computed live from its report and the
   * current applications (so ones added later show up too). Undefined when
   * the run isn't from a tracked API: there's no API to match applications on.
   */
  async applicationsForRun(runId: string): Promise<AppImpactSummary[] | undefined> {
    const meta = this.options.runs.get(runId);
    if (!meta?.origin) return undefined;
    const report = await this.options.runs.report(runId);
    if (!report) return undefined;
    const summaries: AppImpactSummary[] = [];
    for (const app of this.apps.filter((a) => a.dependencies.some((d) => d.apiId === meta.origin!.apiId))) {
      const impact = this.impactFor(app, meta, report);
      if (!impact) continue;
      summaries.push({ id: app.id, name: app.name, owner: app.owner, unitIds: [...new Set(impact.changes.map((c) => c.unitId))], counts: impact.counts });
    }
    return summaries;
  }

  async renderRunReport(runId: string): Promise<string | undefined> {
    const report = await this.options.runs.report(runId);
    if (!report) return undefined;
    return renderMarkdownReport(report, { applications: await this.applicationsForRun(runId) });
  }

  // ---- channels -----------------------------------------------------------

  listChannels() {
    return this.channels.map(redactChannel);
  }

  async createChannel(input: NewChannel) {
    validateChannel(input);
    const channel: Channel = { ...input, id: `${slug(input.name)}-${randomBytes(2).toString("hex")}`, enabled: input.enabled ?? true, createdAt: new Date().toISOString() };
    this.channels.push(channel);
    await this.saveChannels();
    return redactChannel(channel);
  }

  async updateChannel(id: string, patch: Partial<NewChannel>) {
    const channel = this.requireChannel(id);
    const keep = <T>(next: T | undefined, current: T) => (next === undefined || next === REDACTED ? current : next);
    const updated: Channel = {
      ...channel,
      ...patch,
      url: keep(patch.url, channel.url),
      secret: keep(patch.secret, channel.secret),
      token: keep(patch.token, channel.token),
      headers: patch.headers
        ? Object.fromEntries(Object.entries(patch.headers).map(([k, v]) => [k, v === REDACTED ? (channel.headers?.[k] ?? "") : v]))
        : channel.headers,
    };
    validateChannel(updated);
    Object.assign(channel, updated);
    await this.saveChannels();
    return redactChannel(channel);
  }

  async deleteChannel(id: string) {
    this.requireChannel(id);
    this.channels = this.channels.filter((c) => c.id !== id);
    for (const app of this.apps) app.channelIds = app.channelIds.filter((c) => c !== id);
    await this.saveChannels();
    await this.saveApps();
  }

  async testChannel(id: string): Promise<Delivery> {
    const channel = this.requireChannel(id);
    const delivery = await deliver(channel, { kind: "test", channel }, this.options.deliverOptions);
    await this.recordDelivery(delivery);
    return delivery;
  }

  async deliveries(limit = 200): Promise<Delivery[]> {
    return (await this.readJsonl<Delivery>("deliveries.jsonl")).slice(-limit).reverse();
  }

  // ---- reports --------------------------------------------------------------

  impactsFor(filter: ReportFilter): ImpactRecord[] {
    const since = filter.sinceDays ? Date.now() - filter.sinceDays * 86_400_000 : 0;
    return [...this.impacts.values()]
      .filter((i) => (!filter.appId || i.appId === filter.appId) && (!filter.apiId || i.apiId === filter.apiId) && Date.parse(i.at) >= since)
      .filter((i) => !filter.minSeverity || meetsSeverity(i, filter.minSeverity))
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  reportMarkdown(filter: ReportFilter): string {
    const rows = this.impactsFor(filter);
    const scope = [filter.sinceDays ? `last ${filter.sinceDays} days` : "all time", filter.minSeverity ? `${filter.minSeverity} or worse` : "all severities"].join(", ");
    const out = [`# Breaking changes report`, "", `Scope: ${scope}. Generated ${new Date().toISOString()}.`, ""];
    if (rows.length === 0) return [...out, "No impacts in this scope."].join("\n");
    const byApp = new Map<string, ImpactRecord[]>();
    for (const r of rows) byApp.set(r.appName, [...(byApp.get(r.appName) ?? []), r]);
    out.push("| Application | Impacts | Breaking | Warning |", "|---|---|---|---|");
    for (const [app, list] of byApp) out.push(`| ${app} | ${list.length} | ${sum(list, "breaking")} | ${sum(list, "warning")} |`);
    for (const [app, list] of byApp) {
      out.push("", `## ${app}`);
      for (const r of list) {
        out.push("", `### ${r.apiName} v${r.from.version ?? "?"} → v${r.to.version ?? "?"} (${r.at.slice(0, 10)})`, "");
        out.push(`${r.counts.breaking} breaking, ${r.counts.warning} warning, ${r.counts.info} info.${this.publicUrl ? ` [Report](${this.reportUrl(r.runId)})` : ""}`, "");
        for (const c of r.changes.filter((c) => c.severity !== "info")) out.push(`- **${c.severity}** \`${c.location}\`: ${c.message}`);
        for (const risk of r.risks) out.push(`- Risk (${risk.severity}): ${risk.title}. ${risk.failureScenario}`);
      }
    }
    return out.join("\n");
  }

  reportCsv(filter: ReportFilter): string {
    const header = ["date", "application", "api", "from_version", "to_version", "severity", "location", "change", "run_id"];
    const lines = [header.join(",")];
    for (const r of this.impactsFor(filter)) {
      for (const c of r.changes) {
        lines.push([r.at, r.appName, r.apiName, r.from.version ?? "", r.to.version ?? "", c.severity, c.location, c.message, r.runId].map(csv).join(","));
      }
    }
    return `${lines.join("\n")}\n`;
  }

  reportUrl(runId: string): string | undefined {
    return this.publicUrl ? `${this.publicUrl.replace(/\/+$/, "")}/#/runs/${runId}` : undefined;
  }

  // ---- internals -------------------------------------------------------------

  /**
   * New tracked-API versions: record impacts and notify the affected applications.
   * A rerun of such a change replaces the original's impacts (now with the
   * rerun's risks) without notifying again: the change itself was already announced.
   */
  private async onRunFinished(meta: RunMeta, report: ComparisonReport | undefined) {
    if (!meta.origin || meta.origin.trigger === "compare" || !report) return;
    const isRetry = meta.origin.trigger === "retry";
    if (isRetry && meta.retryOf) {
      for (const [key, impact] of this.impacts) if (impact.runId === meta.retryOf) this.impacts.delete(key);
      if (meta.status === "done") await this.options.tracker.relinkRun(meta.origin.apiId, meta.origin.toSnapshot, meta.id);
    }
    const affected = this.apps.filter((a) => a.dependencies.some((d) => d.apiId === meta.origin!.apiId));
    for (const app of affected) {
      const impact = this.impactFor(app, meta, report);
      if (!impact) continue;
      this.impacts.set(impact.id, impact);
      if (isRetry) continue;
      await appendFile(join(this.options.dir, "impacts.jsonl"), `${JSON.stringify(impact)}\n`);
      if (!meetsSeverity(impact, app.minSeverity)) continue;
      const event: NotificationEvent = { kind: "impact", app, impact, reportUrl: this.reportUrl(impact.runId) };
      const channels = this.channels.filter((c) => c.enabled && app.channelIds.includes(c.id));
      for (const delivery of await Promise.all(channels.map((c) => deliver(c, event, this.options.deliverOptions)))) {
        await this.recordDelivery(delivery);
      }
    }
    if (isRetry) await this.saveImpacts();
    // The run wrote report.md before impacts existed; refresh it with the applications.
    const markdown = await this.renderRunReport(meta.id);
    if (markdown) await this.options.runs.writeReportMarkdown(meta.id, markdown);
  }

  private impactFor(app: Application, meta: RunMeta, report: ComparisonReport) {
    const origin = meta.origin!;
    const history = this.options.tracker.has(origin.apiId) ? this.options.tracker.history(origin.apiId) : [];
    const ref = (id: string): VersionRef => {
      const v = history.find((h) => h.id === id);
      return { id, seq: v?.seq ?? Number(id.split("-")[0]), version: v?.summary.version };
    };
    return computeImpact(app, report, {
      runId: meta.id,
      at: meta.createdAt,
      apiId: origin.apiId,
      apiName: origin.apiName,
      from: ref(origin.fromSnapshot),
      to: ref(origin.toSnapshot),
    });
  }

  private validateDependencies(deps: Dependency[]) {
    for (const d of deps) {
      if (!this.options.tracker.has(d.apiId)) throw new Error(`Unknown tracked API "${d.apiId}"`);
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

  private async recordDelivery(delivery: Delivery) {
    await appendFile(join(this.options.dir, "deliveries.jsonl"), `${JSON.stringify(delivery)}\n`);
  }

  private requireApp(id: string): Application {
    const app = this.apps.find((a) => a.id === id);
    if (!app) throw new NotFoundError(`No application ${id}`);
    return app;
  }

  private requireChannel(id: string): Channel {
    const channel = this.channels.find((c) => c.id === id);
    if (!channel) throw new NotFoundError(`No channel ${id}`);
    return channel;
  }

  private async saveApps() {
    await writeFile(join(this.options.dir, "applications.json"), JSON.stringify(this.apps, null, 2));
  }

  private async saveChannels() {
    const file = join(this.options.dir, "channels.json");
    await writeFile(file, JSON.stringify(this.channels, null, 2), { mode: 0o600 });
    await chmod(file, 0o600); // webhook URLs and tokens are credentials
  }

  private async saveImpacts() {
    await writeFile(join(this.options.dir, "impacts.jsonl"), [...this.impacts.values()].map((i) => `${JSON.stringify(i)}\n`).join(""));
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    const file = join(this.options.dir, name);
    return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as T) : fallback;
  }

  private async readJsonl<T>(name: string): Promise<T[]> {
    const file = join(this.options.dir, name);
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  }
}

export class NotFoundError extends Error {}

function normalizeDependencies(deps: Dependency[]): Dependency[] {
  const merged = new Map<string, Dependency>();
  for (const d of deps) {
    const ops = d.operations === "all" ? "all" : [...new Set(d.operations.map((o) => operationKey(o)!))].sort();
    merged.set(d.apiId, { apiId: d.apiId, operations: ops, ...(d.note && { note: d.note }) });
  }
  return [...merged.values()];
}

function validateChannel(c: Pick<Channel, "type" | "url" | "name" | "token">) {
  if (!c.name.trim()) throw new Error("Channel name is required");
  let url: URL;
  try {
    url = new URL(c.url);
  } catch {
    throw new Error(`"${c.url}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Channel URLs must be http(s)");
  // Hosted services only accept https; plain http is allowed for your own receivers.
  if (["slack", "teams", "discord", "github"].includes(c.type) && url.protocol !== "https:") throw new Error(`${c.type} URLs must use https`);
  if ((c.type === "github" || c.type === "gitlab") && !c.token) throw new Error(`${c.type} channels need a token`);
}

/** Webhook URLs embed their credentials, so only the host is shown. */
function redactChannel(c: Channel): Channel {
  let shown = REDACTED;
  try {
    shown = `${new URL(c.url).origin}/${REDACTED}`;
  } catch {
  }
  return {
    ...c,
    url: shown,
    ...(c.secret && { secret: REDACTED }),
    ...(c.token && { token: REDACTED }),
    ...(c.headers && { headers: Object.fromEntries(Object.keys(c.headers).map((k) => [k, REDACTED])) }),
  };
}

const sum = (list: ImpactRecord[], s: Severity) => list.reduce((n, r) => n + r.counts[s], 0);
/** CSV cell; a leading =, +, - or @ is defused so doc text can't run as a spreadsheet formula. */
const csv = (raw: string) => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

