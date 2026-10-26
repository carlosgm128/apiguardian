// Packages recorded runs and a tracked API's history into the dashboard demo's
// dataset (frontend/src/demo/recording.json). The demo replays these in the
// browser, so everything that needs backend code (report.md with the
// applications summary, operations per snapshot, notification payloads) is
// computed here with the real modules.
//
//   npx tsx backend/scripts/export-demo.ts <source-dir> [--out frontend/src/demo/recording.json]
//
// <source-dir>/runs/<role>/  events.jsonl, report.json and optionally meta.json
//                            (a run directory from `serve`, or a `compare --out` directory)
// <source-dir>/api/          a tracked API directory from --apis-dir (api.json, versions.json,
//                            checks.jsonl, snapshots/) with at least three versions;
//                            tracker-1 and tracker-2 are its runs for versions 2 and 3.

import SwaggerParser from "@apidevtools/swagger-parser";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { computeImpact } from "../src/apps/impact.js";
import { buildRequest } from "../src/apps/notify.js";
import type { Application, Channel, VersionRef } from "../src/apps/types.js";
import type { RunEvent } from "../src/events.js";
import type { CheckRecord, Snapshot, TrackedApi } from "../src/history/tracker.js";
import type { ComparisonReport } from "../src/orchestrator.js";
import { renderMarkdownReport, type AppImpactSummary } from "../src/report/markdown.js";
import { summarize, type RunConfig, type RunMeta } from "../src/server/runs.js";
import { normalizeDocument } from "../src/swagger/normalize.js";

/** Roles the demo knows how to use; see frontend/src/demo/server.ts. */
const ROLES = [
  "petstore-ollama", "petstore-gpu", "petstore-simulate", "petstore-diff",
  "docs-ollama", "docs-simulate", "docs-diff",
  "lead-failed", "lead-rerun",
  "tracker-1", "tracker-2",
] as const;
type Role = (typeof ROLES)[number];

const API_ID = "petstore";
const API_URL = "https://petstore.acme.example/v3/api-docs";
/** Stands in for run ids in precomputed text; the demo swaps in the real id. */
const RUN_PLACEHOLDER = "{{runId}}";
const PUBLIC_URL = "https://apiguardian.acme.example";

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1]! : "frontend/src/demo/recording.json";
if (!source) {
  console.error("usage: tsx backend/scripts/export-demo.ts <source-dir> [--out file]");
  process.exit(1);
}

const seed = JSON.parse(await readFile("frontend/src/demo/seed.json", "utf8")) as { applications: Application[]; channels: Channel[] };

// ---- tracked API ------------------------------------------------------------

const apiDir = join(source, "api");
const storedApi = JSON.parse(await readFile(join(apiDir, "api.json"), "utf8")) as TrackedApi;
const versions = (JSON.parse(await readFile(join(apiDir, "versions.json"), "utf8")) as Snapshot[]).slice(0, 3);
const checks = (await readFile(join(apiDir, "checks.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as CheckRecord).slice(0, 3);
if (versions.length < 3) throw new Error("The tracked API needs at least three versions");

const snapshots: Record<string, unknown> = {};
const operations: Record<string, unknown[]> = {};
for (const v of versions) {
  const doc = JSON.parse(await readFile(join(apiDir, "snapshots", `${v.id}.json`), "utf8"));
  snapshots[v.id] = doc;
  const spec = normalizeDocument((await SwaggerParser.dereference(structuredClone(doc))) as Record<string, any>);
  operations[v.id] = Object.values(spec.operations)
    .map((op) => ({ key: op.key, method: op.method, path: op.path, summary: op.summary, deprecated: op.deprecated }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

// ---- runs -------------------------------------------------------------------

interface Recording {
  meta: RunMeta;
  events: RunEvent[];
  report: ComparisonReport;
  /** report.md as the server renders it (with the applications summary for tracker runs). */
  markdown: string;
}

const runs = {} as Record<Role, Recording>;
for (const role of ROLES) {
  const dir = join(source, "runs", role);
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunEvent);
  const report = withDefaults(JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as ComparisonReport);
  const meta = existsSync(join(dir, "meta.json")) ? (JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as RunMeta) : metaFromEvents(role, events, report);
  delete meta.retriedBy;
  meta.summary = summarize(events);
  if (role.startsWith("tracker-")) {
    const v = role === "tracker-1" ? 1 : 2;
    meta.source = "tracker";
    meta.origin = { apiId: API_ID, apiName: storedApi.name, fromSnapshot: versions[v - 1]!.id, toSnapshot: versions[v]!.id, trigger: "check" };
    versions[v]!.runId = meta.id;
    checks[v]!.runId = meta.id;
  } else {
    delete meta.origin;
    if (meta.source === "tracker") meta.source = "dashboard";
  }
  runs[role] = { meta, events, report, markdown: "" };
}

const ref = (id: string): VersionRef => {
  const v = versions.find((s) => s.id === id)!;
  return { id, seq: v.seq, version: v.summary.version };
};
const impactOf = (app: Application, rec: Recording, runId = rec.meta.id) =>
  computeImpact(app, rec.report, {
    runId,
    at: rec.meta.createdAt,
    apiId: API_ID,
    apiName: storedApi.name,
    from: ref(rec.meta.origin!.fromSnapshot),
    to: ref(rec.meta.origin!.toSnapshot),
  });

for (const rec of Object.values(runs)) {
  let applications: AppImpactSummary[] | undefined;
  if (rec.meta.origin) {
    applications = [];
    for (const app of seed.applications) {
      const impact = impactOf(app, rec);
      if (impact) applications.push({ id: app.id, name: app.name, owner: app.owner, unitIds: [...new Set(impact.changes.map((c) => c.unitId))], counts: impact.counts });
    }
  }
  rec.markdown = renderMarkdownReport(rec.report, { applications });
}

// What "Check now" sends: tracker-2's impact on each seeded application, per channel.
const notifications: Record<string, { url: string; headers: Record<string, string>; body: string }> = {};
for (const app of seed.applications) {
  const impact = impactOf(app, runs["tracker-2"], RUN_PLACEHOLDER);
  if (!impact) continue;
  for (const channel of seed.channels.filter((c) => app.channelIds.includes(c.id))) {
    const req = buildRequest(channel, { kind: "impact", app, impact, reportUrl: `${PUBLIC_URL}/#/runs/${RUN_PLACEHOLDER}` });
    notifications[`${app.id}/${channel.id}`] = req;
  }
}

const api: TrackedApi = {
  ...storedApi,
  id: API_ID,
  url: API_URL,
  headers: { Authorization: "Bearer demo" },
  lastCheckedAt: versions[1]!.fetchedAt,
  lastOutcome: "changed",
};
for (const v of versions) v.url = API_URL;

const recording = {
  recordedAt: new Date().toISOString(),
  runs,
  api: { api, versions, checks, snapshots, operations },
  notifications,
  runPlaceholder: RUN_PLACEHOLDER,
};

// Recorded prompts and paths can name local directories; keep only file names.
const text = JSON.stringify(recording).replace(/(?:\/home|\/tmp|\/Users)\/[^"\s\\]*\/([^/"\s\\]+)/g, "$1");
const home = process.env.HOME;
if (home && text.includes(home)) throw new Error(`Local path left in the export: ${home}`);
await writeFile(out, text);
console.log(`wrote ${out} (${(text.length / 1024).toFixed(0)} KB): ${ROLES.length} runs, ${versions.length} versions, ${Object.keys(notifications).length} notification payloads`);

// ---- helpers ----------------------------------------------------------------

/** Reports from older builds lack fields the renderer expects. */
function withDefaults(report: ComparisonReport): ComparisonReport {
  const defaults: Partial<ComparisonReport> = { investigations: [], failedUnits: [], skippedUnits: [], notRunUnits: [], reusedUnits: [], analyses: {} };
  return { ...defaults, ...report };
}

/** `compare --out` directories have no meta.json; rebuild it from the events. */
function metaFromEvents(role: Role, events: RunEvent[], report: ComparisonReport): RunMeta {
  const start = events.find((e) => e.type === "run-start");
  const calls = events.filter((e) => e.type === "llm-call");
  const worker = calls.find((e) => e.role === "worker");
  const lead = calls.find((e) => e.role === "lead");
  const provider = worker?.provider ?? lead?.provider;
  const mode: RunConfig["mode"] = provider === "simulated" ? "simulate" : provider === "ollama" ? "ollama" : provider === "claude" ? "claude" : "diff";
  const endpoints = [...new Set(calls.filter((e) => e.role === "worker" && e.endpoint).map((e) => e.endpoint!))];
  const config: RunConfig = {
    mode,
    concurrency: 4,
    skipInfo: false,
    ...(mode !== "diff" && worker && { workerModel: worker.model }),
    ...(mode !== "diff" && lead && { leadModel: lead.model }),
    ...(endpoints.length > 0 && { workerEndpoints: endpoints }),
  };
  return {
    id: `rec-${role}`,
    createdAt: new Date(events[0]?.t ?? Date.now()).toISOString(),
    status: report.stopped?.reason === "cancelled" ? "cancelled" : report.stopped || report.synthesisError ? "failed" : "done",
    source: "dashboard",
    config,
    baselineName: basename(start?.type === "run-start" ? start.baselinePath : report.baselinePath),
    candidateName: basename(start?.type === "run-start" ? start.candidatePath : report.candidatePath),
    summary: summarize(events),
    ...(report.synthesisError && { error: report.synthesisError }),
  };
}

