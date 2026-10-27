import type { CheckOutcome, CheckRecord, TrackedApi } from "./tracker.js";

// Aggregates check logs across tracked APIs for the Monitoring page. Pure, so the
// demo build keeps a copy (frontend/src/demo/mirror.ts): keep the two in sync.

/** A check with the API it belongs to, for the cross-API monitoring view. */
export type MonitoringCheck = CheckRecord & { apiId: string; apiName: string };

export interface MonitoringApi {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  intervalMinutes: number;
  versions: number;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastOutcome?: CheckOutcome;
  lastError?: string;
  /** Last check that found a new version (or the first snapshot), from all history. */
  lastChangeAt?: string;
  /** Counts within the window. */
  stats: Record<CheckOutcome, number> & { checks: number; avgDurationMs?: number };
}

export interface MonitoringReport {
  generatedAt: string;
  windowDays: number;
  scheduler: { running: boolean; tickMs?: number };
  apis: MonitoringApi[];
  /** Check counts per UTC day in the window, oldest first (empty days included). */
  daily: Array<{ day: string } & Record<CheckOutcome, number>>;
  /** Newest first, across all APIs, capped by `limit`. */
  checks: MonitoringCheck[];
  /** Checks in the window before the cap. */
  totalChecks: number;
}

export interface MonitoringInput {
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
