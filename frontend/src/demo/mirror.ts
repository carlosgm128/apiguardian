// Pure helpers mirrored from the backend for the demo's in-browser server
// (backend code can't be bundled). Keep in sync with:
//   computeImpact, meetsSeverity  backend/src/apps/impact.ts
//   summarize                     backend/src/server/runs.ts
//   reportMarkdown, reportCsv     backend/src/apps/service.ts
//   summarizeMonitoring           backend/src/history/monitoring.ts
import type { CheckRecord, ImpactRecord, MonitoringApi, MonitoringCheck, MonitoringReport, RunEvent, RunSummary, Severity, TrackedApi } from "../types";
import type { Application, ComparisonReport, VersionRef } from "./types";

const GLOBAL_UNIT_ID = "spec:global";
export const SEVERITY_RANK: Record<Severity, number> = { info: 1, warning: 2, breaking: 3 };

export function computeImpact(
  app: Application,
  report: ComparisonReport,
  ctx: { runId: string; at: string; apiId: string; apiName: string; from: VersionRef; to: VersionRef },
): ImpactRecord | undefined {
  const dependency = app.dependencies.find((d) => d.apiId === ctx.apiId);
  if (!dependency) return undefined;
  const uses = (unitId: string) =>
    dependency.operations === "all" || unitId === GLOBAL_UNIT_ID || dependency.operations.includes(unitId);

  const units = report.diff.units.filter((u) => uses(u.id));
  const unitIds = new Set(units.map((u) => u.id));
  const changes = units.flatMap((u) =>
    u.changes.map((c) => ({ id: c.id, unitId: u.id, severity: c.severity, location: c.location, message: c.message })),
  );
  const risks = (report.riskReport?.risks ?? [])
    .filter((r) => dependency.operations === "all" || r.affectedUnits.some((id) => unitIds.has(id)))
    .map(({ title, severity, failureScenario, mitigation }) => ({ title, severity, failureScenario, mitigation }));
  if (changes.length === 0 && risks.length === 0) return undefined;

  const counts: Record<Severity, number> = { breaking: 0, warning: 0, info: 0 };
  for (const c of changes) counts[c.severity]++;
  const worst = (["breaking", "warning", "info"] as const).find((s) => counts[s] > 0) ?? null;

  return {
    id: `${ctx.runId}:${app.id}`,
    at: ctx.at,
    runId: ctx.runId,
    appId: app.id,
    appName: app.name,
    apiId: ctx.apiId,
    apiName: ctx.apiName,
    from: ctx.from,
    to: ctx.to,
    counts,
    worst,
    changes: changes.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    risks,
  };
}

export function meetsSeverity(impact: ImpactRecord, min: Severity): boolean {
  const worst: Severity = impact.worst ?? "warning";
  return SEVERITY_RANK[worst] >= SEVERITY_RANK[min];
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

const sum = (list: ImpactRecord[], s: Severity) => list.reduce((n, r) => n + r.counts[s], 0);
const csv = (raw: string) => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function reportMarkdown(rows: ImpactRecord[], filter: { sinceDays?: number; minSeverity?: Severity }): string {
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
      out.push(`${r.counts.breaking} breaking, ${r.counts.warning} warning, ${r.counts.info} info.`, "");
      for (const c of r.changes.filter((c) => c.severity !== "info")) out.push(`- **${c.severity}** \`${c.location}\`: ${c.message}`);
      for (const risk of r.risks) out.push(`- Risk (${risk.severity}): ${risk.title}. ${risk.failureScenario}`);
    }
  }
  return out.join("\n");
}

export function reportCsv(rows: ImpactRecord[]): string {
  const header = ["date", "application", "api", "from_version", "to_version", "severity", "location", "change", "run_id"];
  const lines = [header.join(",")];
  for (const r of rows) {
    for (const c of r.changes) {
      lines.push([r.at, r.appName, r.apiName, r.from.version ?? "", r.to.version ?? "", c.severity, c.location, c.message, r.runId].map(csv).join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}

interface MonitoringInput {
  api: TrackedApi;
  versions: number;
  /** Newest first, the whole history. */
  checks: CheckRecord[];
}

const DAY_MS = 86_400_000;

export function summarizeMonitoring(
  inputs: MonitoringInput[],
  o: { now: number; days: number; limit: number; scheduler: MonitoringReport["scheduler"] },
): MonitoringReport {
  const firstDay = Math.floor(o.now / DAY_MS) * DAY_MS - (o.days - 1) * DAY_MS;
  const daily = Array.from({ length: o.days }, (_, i) => ({ day: new Date(firstDay + i * DAY_MS).toISOString().slice(0, 10), baseline: 0, unchanged: 0, changed: 0, error: 0 }));
  const all: MonitoringCheck[] = [];
  const apis: MonitoringApi[] = inputs.map(({ api, versions, checks }) => {
    const inWindow = checks.filter((c) => Date.parse(c.at) >= firstDay);
    const stats: MonitoringApi["stats"] = { checks: inWindow.length, baseline: 0, unchanged: 0, changed: 0, error: 0 };
    for (const c of inWindow) {
      stats[c.outcome]++;
      const bucket = daily[Math.floor((Date.parse(c.at) - firstDay) / DAY_MS)];
      if (bucket) bucket[c.outcome]++;
      all.push({ ...c, apiId: api.id, apiName: api.name });
    }
    if (inWindow.length) stats.avgDurationMs = Math.round(inWindow.reduce((n, c) => n + c.durationMs, 0) / inWindow.length);
    return {
      id: api.id,
      name: api.name,
      url: api.url,
      enabled: api.enabled,
      intervalMinutes: api.intervalMinutes,
      versions,
      lastCheckedAt: api.lastCheckedAt,
      nextCheckAt: api.nextCheckAt,
      lastOutcome: api.lastOutcome,
      lastError: api.lastError,
      lastChangeAt: checks.find((c) => c.outcome === "changed" || c.outcome === "baseline")?.at,
      stats,
    };
  });
  all.sort((a, b) => b.at.localeCompare(a.at));
  return {
    generatedAt: new Date(o.now).toISOString(),
    windowDays: o.days,
    scheduler: o.scheduler,
    apis: apis.sort((a, b) => a.name.localeCompare(b.name)),
    daily,
    checks: all.slice(0, o.limit),
    totalChecks: all.length,
  };
}
