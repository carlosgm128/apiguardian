import type { ComparisonReport } from "../orchestrator.js";
import type { Change, Severity, WorkUnit } from "../types.js";

const SEVERITY_ORDER: Severity[] = ["breaking", "warning", "info"];
const RISK_ORDER = ["critical", "high", "medium", "low"] as const;

/** One application affected by this run (from the apps service's impact records). */
export interface AppImpactSummary {
  id?: string;
  name: string;
  owner?: string;
  /** Changed units (endpoints/sections, plus spec:global) the application uses. */
  unitIds: string[];
  counts: Record<Severity, number>;
}

export interface ReportContext {
  /**
   * Applications affected by this run. Undefined when the run isn't from a
   * tracked API, so applications can't be matched; an empty list means
   * none of the registered applications use the changed parts.
   */
  applications?: AppImpactSummary[];
}

export function renderMarkdownReport(report: ComparisonReport, context: ReportContext = {}): string {
  const { diff } = report;
  const counts = { breaking: 0, warning: 0, info: 0 };
  for (const u of diff.units) for (const c of u.changes) counts[c.severity]++;

  const out: string[] = [
    "# API documentation review",
    "",
    ...(report.simulated ? ["> **Simulated run:** agent findings and risks below are generated placeholders, not model output.", ""] : []),
    `- **Baseline:** \`${report.baselinePath}\`${diff.baselineVersion ? ` (version ${diff.baselineVersion})` : ""}`,
    `- **Candidate:** \`${report.candidatePath}\`${diff.candidateVersion ? ` (version ${diff.candidateVersion})` : ""}`,
    `- **Format:** ${diff.format}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Changes found:** ${counts.breaking} breaking, ${counts.warning} warning, ${counts.info} info across ${diff.units.length} units`,
    ...(report.retryOf
      ? [`- **Retry of run:** \`${report.retryOf}\`${report.reusedUnits.length ? ` (${report.reusedUnits.length} worker analyses reused)` : ""}`]
      : []),
    ...(report.stopped
      ? [`- **Stopped early:** ${report.stopped.reason === "cancelled" ? "cancelled by the user" : `fatal agent error: ${report.stopped.error}`}`]
      : []),
    "",
  ];

  out.push(...renderSummary(report, context));

  out.push("## What could fail", "");
  if (report.riskReport) {
    out.push(report.riskReport.overview, "");
    const risks = [...report.riskReport.risks].sort(
      (a, b) => RISK_ORDER.indexOf(a.severity) - RISK_ORDER.indexOf(b.severity),
    );
    risks.forEach((r, i) => {
      out.push(
        `### ${i + 1}. [${r.severity}] ${r.title}`,
        "",
        r.description,
        "",
        `- **Failure scenario:** ${r.failureScenario}`,
        `- **Likelihood:** ${r.likelihood}`,
        `- **Affected:** ${r.affectedUnits.map((u) => `\`${u}\``).join(", ") || "n/a"}`,
        `- **Mitigation:** ${r.mitigation}`,
        "",
      );
    });
    if (report.riskReport.crossCuttingNotes.length > 0) {
      out.push("**Cross-cutting notes**", "", ...report.riskReport.crossCuttingNotes.map((n) => `- ${n}`), "");
    }
  } else if (report.synthesisError) {
    out.push(`The lead agent failed: ${report.synthesisError}. Per-unit risks are listed below.`, "");
  } else {
    out.push("Agents were not run, so only deterministic breaking and warning changes are listed:", "");
    const flagged = diff.units.flatMap((u) => u.changes).filter((c) => c.severity !== "info");
    out.push(...(flagged.length ? flagged.map((c) => `- [${c.severity}] ${c.location}: ${c.message}`) : ["- None."]), "");
  }

  out.push("## What changed and how", "");
  if (diff.units.length === 0) out.push("No differences found.", "");
  for (const unit of sortUnits(diff.units)) out.push(...renderUnit(unit, report));

  if (report.failedUnits.length > 0 || report.skippedUnits.length > 0 || report.notRunUnits.length > 0) {
    out.push("## Not reviewed by an agent", "");
    for (const f of report.failedUnits) out.push(`- \`${f.unitId}\`: failed (${f.error})`);
    for (const id of report.skippedUnits) out.push(`- \`${id}\`: skipped (info-only changes)`);
    for (const id of report.notRunUnits) out.push(`- \`${id}\`: not run (run stopped early)`);
    out.push("");
  }

  return out.join("\n");
}

/** Short version at the top: every changed endpoint, and who is affected. */
function renderSummary(report: ComparisonReport, context: ReportContext): string[] {
  const units = sortUnits(report.diff.units);
  const out = ["## Summary", ""];
  if (units.length === 0) return [...out, "No differences found.", ""];

  const noun = report.diff.format === "markdown" ? "section" : "endpoint";
  const apps = context.applications;
  const appsByUnit = new Map<string, string[]>();
  for (const app of apps ?? []) for (const id of app.unitIds) appsByUnit.set(id, [...(appsByUnit.get(id) ?? []), app.name]);
  const total = { breaking: 0, warning: 0, info: 0 };
  for (const u of units) for (const c of u.changes) total[c.severity]++;

  out.push(
    `**${total.breaking} breaking**, ${total.warning} warning and ${total.info} info changes in ${units.length} ${noun}${units.length === 1 ? "" : "s"}` +
      (apps ? `; **${apps.length} application${apps.length === 1 ? "" : "s"} affected**.` : "."),
    "",
    `| ${capitalize(noun)} | Change | Breaking | Warning | Info |${apps ? " Applications affected |" : ""}`,
    `|---|---|---|---|---|${apps ? "---|" : ""}`,
  );
  for (const u of units) {
    const c = countBySeverity(u.changes);
    const users = appsByUnit.get(u.id);
    out.push(`| ${cell(u.title)} | ${u.status} | ${c.breaking} | ${c.warning} | ${c.info} |${apps ? ` ${users ? cell(users.join(", ")) : "–"} |` : ""}`);
  }
  out.push("");

  if (!apps) {
    out.push("_Applications are matched only for tracked APIs (the dashboard's APIs page); this comparison isn't from one._", "");
    return out;
  }
  if (apps.length === 0) {
    out.push("No registered application uses the changed parts of this API.", "");
    return out;
  }
  const title = new Map(units.map((u) => [u.id, u.title]));
  out.push("### Applications affected", "", `| Application | Owner | Changed ${noun}s it uses | Breaking | Warning |`, "|---|---|---|---|---|");
  for (const app of [...apps].sort((a, b) => b.counts.breaking - a.counts.breaking || b.counts.warning - a.counts.warning || a.name.localeCompare(b.name))) {
    const used = app.unitIds.map((id) => title.get(id) ?? id).join(", ");
    out.push(`| ${cell(app.name)} | ${cell(app.owner ?? "–")} | ${cell(used)} | ${app.counts.breaking} | ${app.counts.warning} |`);
  }
  out.push("");
  return out;
}

function countBySeverity(changes: Change[]): Record<Severity, number> {
  const c = { breaking: 0, warning: 0, info: 0 };
  for (const ch of changes) c[ch.severity]++;
  return c;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function renderUnit(unit: WorkUnit, report: ComparisonReport): string[] {
  const out = [`### ${unit.title} (${unit.status})`, ""];
  const analysis = report.analyses[unit.id];
  if (analysis) out.push(analysis.summary, "");

  out.push("| Severity | Location | Change | Before | After |", "|---|---|---|---|---|");
  for (const c of sortChanges(unit.changes)) {
    out.push(`| ${c.severity} | ${cell(c.location)} | ${cell(c.message)} | ${cell(fmt(c.before))} | ${cell(fmt(c.after))} |`);
  }
  out.push("");

  if (analysis && analysis.findings.length > 0) {
    out.push("**Findings**", "");
    for (const f of analysis.findings) {
      out.push(`- **[${f.severity}] ${f.title}** (${f.baselineRef}): ${f.what} ${f.how}`);
    }
    out.push("");
  }
  if (analysis && analysis.risks.length > 0) {
    out.push("**Risks**", "");
    for (const r of analysis.risks) {
      out.push(`- ${r.description} (likelihood ${r.likelihood}, impact ${r.impact}). *Scenario:* ${r.failureScenario} *Mitigation:* ${r.mitigation}`);
    }
    out.push("");
  }
  if (unit.diff) out.push("<details><summary>Text diff</summary>", "", "```diff", unit.diff, "```", "", "</details>", "");
  return out;
}

const worst = (u: WorkUnit) => Math.min(...u.changes.map((c) => SEVERITY_ORDER.indexOf(c.severity)));
const sortUnits = (units: WorkUnit[]) => [...units].sort((a, b) => worst(a) - worst(b) || a.id.localeCompare(b.id));
const sortChanges = (changes: Change[]) =>
  [...changes].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

function fmt(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
