import type { ComparisonReport } from "../orchestrator.js";
import { GLOBAL_UNIT_ID } from "../swagger/diff.js";
import type { Severity } from "../types.js";
import { SEVERITY_RANK, type Application, type ImpactRecord, type VersionRef } from "./types.js";

const METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);

/**
 * "GET /pets/{petId}", "get /pets/:id" or "GET https://host/v1/pets/{id}" ->
 * "GET /pets/{}" (the unit-id form). Returns null for anything that isn't
 * METHOD + path.
 */
export function operationKey(input: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(input);
  if (!m) return null;
  const method = m[1]!.toUpperCase();
  if (!METHODS.has(method)) return null;
  let path = m[2]!;
  if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  path = path.split("?")[0]!.replace(/\{[^}]*\}/g, "{}").replace(/\/:[^/]+/g, "/{}");
  if (!path.startsWith("/")) path = `/${path}`;
  return `${method} ${path}`;
}

/** Operation keys from pasted text: one per line, comments and blank lines ignored. */
export function parseOperationList(text: string): { keys: string[]; invalid: string[] } {
  const keys = new Set<string>();
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const key = operationKey(line);
    if (key) keys.add(key);
    else invalid.push(line);
  }
  return { keys: [...keys], invalid };
}

/**
 * The part of one comparison that touches an application: changes in the
 * operations it uses (all of them for "all"), spec-wide changes (servers,
 * security schemes) which affect every consumer, and lead-agent risks on
 * those units. Undefined when nothing touches it.
 */
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

/** True when the impact is at least as severe as the threshold (risk-only impacts count as warnings). */
export function meetsSeverity(impact: ImpactRecord, min: Severity): boolean {
  const worst: Severity = impact.worst ?? "warning";
  return SEVERITY_RANK[worst] >= SEVERITY_RANK[min];
}
