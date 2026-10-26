#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AgentBackend } from "./agents/backend.js";
import type { Effort } from "./agents/claude.js";
import { createBackend, type OllamaSettings, type Provider } from "./agents/factory.js";
import { parseEndpointFlag, startManagedOllama, type ManagedOllama, type OllamaEndpoint } from "./compute/endpoints.js";
import { EventLog, type RunEvent } from "./events.js";
import { compareDocs } from "./orchestrator.js";
import { renderMarkdownReport } from "./report/markdown.js";
import { startDashboardServer } from "./server/http.js";
import { RunManager, type RunConfig } from "./server/runs.js";
import { ApiTracker } from "./history/tracker.js";
import { AppService } from "./apps/service.js";

const USAGE = `Usage:
  apiguardian compare <baseline> <candidate> [options]
  apiguardian serve [--port <n>] [--runs-dir <dir>] [--apis-dir <dir>] [--apps-dir <dir>] [--public-url <url>] [--no-scheduler]
  apiguardian check-apis [--runs-dir <dir>] [--apis-dir <dir>] [--apps-dir <dir>] [--public-url <url>]
  apiguardian ui <report-dir | events.jsonl> [--port <n>]

compare: compares two versions of API docs (Swagger/OpenAPI .yaml/.yml/.json,
or .md) and writes report.md, report.json and events.jsonl.
serve: dashboard for starting, watching and inspecting runs (default runs dir: .apiguardian/runs).
  It also tracks APIs added on its APIs page: their specs are fetched on each API's interval
  and every new version gets a report (stored in .apiguardian/apis). --no-scheduler: on-demand checks only.
  Applications (which APIs they use) and notification channels live in .apiguardian/apps; affected
  applications are notified when a tracked API changes. --public-url: dashboard address used in
  "Open report" links (default: the local server URL).
check-apis: fetch every enabled tracked API once and write reports for new versions, then exit
  (for cron, e.g. */30 * * * * cd /path && npx apiguardian check-apis).
ui: opens a finished run's events.jsonl in the dashboard.

Options:
  --out <dir>            Output directory (default: apiguardian-report)
  --no-agents            Deterministic diff only; no Claude API calls
  --simulate             Fake agent output with realistic timing; no API calls
  --ollama               Run the agents on a local Ollama server instead of Claude
  --lead-provider <p>    claude|ollama: run the lead agent on a different provider than the workers
  --ui                   Watch the run in the dashboard (kept open until Ctrl+C)
  --port <n>             Dashboard port (default: 4319; 0 picks a free one)
  --concurrency <n>      Worker agents running at once (default: 4)
  --skip-info            Don't send info-only units to workers (prose edits are always sent)
  --worker-model <id>    Default: claude-opus-5-5
  --lead-model <id>      Default: claude-opus-5-5
  --worker-effort <lvl>  low|medium|high|xhigh|max (default: medium)
  --lead-effort <lvl>    low|medium|high|xhigh|max (default: high; Claude only)
  --ollama-url <url>     Ollama server (default: $OLLAMA_HOST or http://127.0.0.1:11434)
  --ollama-num-ctx <n>   Context window per Ollama request (default: 16384)
  --ollama-think         Let thinking-capable Ollama models think first (slower)

GPU placement (Ollama). Pinning agents to GPUs needs one Ollama instance per GPU:
  --ollama-gpus <list>   Start and stop one \`ollama serve\` per GPU index, e.g. 0,1 (ids gpu0, gpu1)
  --ollama-base-port <n> First port for those instances (default: 11500)
  --ollama-models <dir>  Model store for those instances (OLLAMA_MODELS); needed when the usual
                         store isn't readable by you, e.g. a systemd install's /usr/share/ollama
  --ollama-endpoint <e>  Use an Ollama instance you run yourself: id=url[@gpu], repeatable,
                         e.g. --ollama-endpoint gpu1=http://127.0.0.1:11435@1
  --worker-endpoints <l> compare: endpoint ids the workers use, e.g. gpu0,gpu1 (default: all)
  --lead-endpoint <id>   compare: endpoint id for the lead (default: first worker endpoint)
  -h, --help

Models: --worker-model/--lead-model take Claude ids or Ollama model names (e.g. qwen3.5:4b).
Without one, Ollama uses the first installed model (tool-capable for the lead).`;

// Sample doc pairs for the dashboard: backend/test/fixtures, found from
// backend/src (tsx) or dist/ (built).
const SAMPLES_DIR = ["../test/fixtures", "../backend/test/fixtures"]
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((dir) => existsSync(dir));

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "apiguardian-report" },
      "no-agents": { type: "boolean", default: false },
      simulate: { type: "boolean", default: false },
      ollama: { type: "boolean", default: false },
      "lead-provider": { type: "string" },
      "ollama-url": { type: "string" },
      "ollama-num-ctx": { type: "string" },
      "ollama-think": { type: "boolean", default: false },
      "ollama-endpoint": { type: "string", multiple: true },
      "ollama-gpus": { type: "string" },
      "ollama-base-port": { type: "string" },
      "ollama-models": { type: "string" },
      "worker-endpoints": { type: "string" },
      "lead-endpoint": { type: "string" },
      ui: { type: "boolean", default: false },
      port: { type: "string", default: "4319" },
      "runs-dir": { type: "string", default: join(".apiguardian", "runs") },
      "apis-dir": { type: "string", default: join(".apiguardian", "apis") },
      "no-scheduler": { type: "boolean", default: false },
      "apps-dir": { type: "string", default: join(".apiguardian", "apps") },
      "public-url": { type: "string" },
      concurrency: { type: "string", default: "4" },
      "skip-info": { type: "boolean", default: false },
      "worker-model": { type: "string" },
      "lead-model": { type: "string" },
      "worker-effort": { type: "string" },
      "lead-effort": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...args] = positionals;
  const port = Number(values.port);
  if (values.help) return console.log(USAGE);
  const ollama: OllamaSettings = {
    baseUrl: values["ollama-url"],
    endpoints: (values["ollama-endpoint"] ?? []).map(parseEndpointFlag),
    numCtx: values["ollama-num-ctx"] ? Number(values["ollama-num-ctx"]) : undefined,
    think: values["ollama-think"],
  };
  /** Starts per-GPU instances (if asked) and adds them to the endpoints. */
  const startGpus = async () => {
    const gpus = values["ollama-gpus"]?.split(",").map((g) => g.trim()).filter(Boolean);
    if (!gpus?.length) return;
    console.error(`Starting ${gpus.length} Ollama instance(s), one per GPU: ${gpus.join(", ")}`);
    const managed = await startManagedOllama({
      gpus,
      basePort: values["ollama-base-port"] ? Number(values["ollama-base-port"]) : undefined,
      modelsDir: values["ollama-models"],
    });
    stopOnExit(managed);
    ollama.endpoints = dedupe([...(ollama.endpoints ?? []), ...managed.endpoints]);
    for (const ep of managed.endpoints) console.error(`  ${ep.id}: ${ep.url} (GPU ${ep.gpus})`);
    return managed;
  };
  if (command === "serve") {
    await startGpus();
    return serve({ runsDir: values["runs-dir"], apisDir: values["apis-dir"], appsDir: values["apps-dir"], publicUrl: values["public-url"], scheduler: !values["no-scheduler"], port, ollama });
  }
  if (command === "check-apis") {
    await startGpus();
    return checkApis(values["runs-dir"], values["apis-dir"], values["apps-dir"], values["public-url"], ollama);
  }
  if (command === "ui" && args[0]) return replay(args[0], port);
  const [baselinePath, candidatePath] = args;
  if (command !== "compare" || !baselinePath || !candidatePath) {
    console.log(USAGE);
    process.exit(1);
  }
  if ([values["no-agents"], values.simulate, values.ollama].filter(Boolean).length > 1) {
    throw new Error("--no-agents, --simulate and --ollama can't be combined");
  }
  const leadProvider = values["lead-provider"];
  if (leadProvider !== undefined && leadProvider !== "claude" && leadProvider !== "ollama") {
    throw new Error(`--lead-provider must be claude or ollama, not "${leadProvider}"`);
  }

  const config: RunConfig = {
    mode: values.simulate ? "simulate" : values["no-agents"] ? "diff" : values.ollama ? "ollama" : "claude",
    leadProvider: leadProvider as Provider | undefined,
    concurrency: Number(values.concurrency),
    skipInfo: values["skip-info"],
    workerModel: values["worker-model"],
    leadModel: values["lead-model"],
    workerEffort: values["worker-effort"] as Effort | undefined,
    leadEffort: values["lead-effort"] as Effort | undefined,
    workerEndpoints: values["worker-endpoints"]?.split(",").map((e) => e.trim()).filter(Boolean),
    leadEndpoint: values["lead-endpoint"],
  };
  const usesOllama = config.mode === "ollama" || config.leadProvider === "ollama";
  const managed = usesOllama ? await startGpus() : undefined;
  const backend: AgentBackend | undefined = createBackend(config, ollama);

  await mkdir(values.out, { recursive: true });
  const log = new EventLog().writeTo(join(values.out, "events.jsonl"));
  log.subscribe(logProgress);

  if (values.ui) {
    const manager = new RunManager();
    const meta = manager.attach(log, { source: "cli", baselineName: basename(baselinePath), candidateName: basename(candidatePath), config });
    const server = await startDashboardServer(manager, { port });
    console.error(`Dashboard: ${server.url}#/runs/${meta.id}`);
  }

  const report = await compareDocs({
    baselinePath,
    candidatePath,
    backend,
    concurrency: config.concurrency,
    skipInfoOnly: config.skipInfo,
    onEvent: (event) => log.record(event),
  });
  await log.close();

  await writeFile(join(values.out, "report.md"), renderMarkdownReport(report));
  await writeFile(join(values.out, "report.json"), JSON.stringify(report, null, 2));

  const changes = report.diff.units.flatMap((u) => u.changes);
  const breaking = changes.filter((c) => c.severity === "breaking").length;
  console.error(
    `\n${changes.length} changes (${breaking} breaking) in ${report.diff.units.length} units` +
      (report.riskReport ? `, ${report.riskReport.risks.length} risks` : "") +
      `. Report: ${join(values.out, "report.md")}`,
  );
  if (report.failedUnits.length > 0 || report.synthesisError || report.stopped) process.exitCode = 2;
  if (values.ui) console.error("Dashboard still running (Ctrl+C to exit)");
  else await managed?.stop();
}

function dedupe(endpoints: OllamaEndpoint[]): OllamaEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((e) => {
    if (seen.has(e.id)) throw new Error(`Duplicate Ollama endpoint id "${e.id}"`);
    seen.add(e.id);
    return true;
  });
}

/** Managed Ollama instances must not outlive apiguardian. */
function stopOnExit(managed: ManagedOllama) {
  const stop = (code: number) => () => void managed.stop().finally(() => process.exit(code));
  process.once("SIGINT", stop(130));
  process.once("SIGTERM", stop(143));
}

async function serve(o: { runsDir: string; apisDir: string; appsDir: string; publicUrl?: string; scheduler: boolean; port: number; ollama: OllamaSettings }) {
  const { runsDir, apisDir, scheduler } = o;
  const manager = await new RunManager({ runsDir, samplesDir: SAMPLES_DIR, ollama: o.ollama }).init();
  const tracker = await new ApiTracker({ dir: apisDir, runs: manager }).init();
  const apps = await new AppService({ dir: o.appsDir, runs: manager, tracker, publicUrl: o.publicUrl }).init();
  const server = await startDashboardServer(manager, { port: o.port, tracker, apps });
  apps.publicUrl ??= server.url;
  // Start checking only once notifications have somewhere to link to.
  if (scheduler) tracker.startScheduler();
  console.error(
    `Dashboard: ${server.url}\nRuns are stored in ${runsDir}; tracked APIs in ${apisDir}` +
      `${scheduler ? "" : " (scheduler off)"} (Ctrl+C to exit)`,
  );
}

/** One pass over all enabled tracked APIs, waiting for the reports of new versions. */
async function checkApis(runsDir: string, apisDir: string, appsDir: string, publicUrl: string | undefined, ollama: OllamaSettings) {
  const manager = await new RunManager({ runsDir, ollama }).init();
  const tracker = await new ApiTracker({ dir: apisDir, runs: manager }).init();
  // Notifies affected applications; the run-finished hook completes before waitForRun returns.
  await new AppService({ dir: appsDir, runs: manager, tracker, publicUrl }).init();
  const apis = tracker.list().filter((a) => a.enabled);
  if (apis.length === 0) console.error(`No enabled tracked APIs in ${apisDir}. Add one in the dashboard (apiguardian serve).`);
  let failed = 0;
  for (const api of apis) {
    const record = await tracker.check(api.id, "cli");
    const run = record.runId ? await manager.waitForRun(record.runId) : undefined;
    const detail =
      record.outcome === "changed" ? `new version ${record.snapshotId}; report ${run?.status ?? "?"}: ${join(runsDir, record.runId ?? "", "report.md")}`
      : record.outcome === "error" ? record.error
      : record.snapshotId;
    if (record.outcome === "error" || (run && run.status !== "done")) failed++;
    console.error(`${api.name}: ${record.outcome}${detail ? ` (${detail})` : ""}`);
  }
  if (failed) process.exitCode = 2;
}

async function replay(target: string, port: number) {
  const file = (await stat(target)).isDirectory() ? join(target, "events.jsonl") : target;
  const log = await EventLog.load(file);
  const start = log.events.find((e) => e.type === "run-start");
  const end = log.events.find((e) => e.type === "run-end");
  const manager = new RunManager();
  const meta = manager.attach(log, {
    source: "replay",
    status: !end ? "failed" : end.stopped === "cancelled" ? "cancelled" : end.stopped === "fatal" ? "failed" : "done",
    baselineName: start ? basename(start.baselinePath) : "?",
    candidateName: start ? basename(start.candidatePath) : "?",
    config: replayConfig(log, start),
  });
  const server = await startDashboardServer(manager, { port });
  console.error(`Replaying ${log.events.length} events from ${file}\nDashboard: ${server.url}#/runs/${meta.id} (Ctrl+C to exit)`);
}

/** Reconstructs which agents a recorded run used, from its events. */
function replayConfig(log: EventLog, start: Extract<RunEvent, { type: "run-start" }> | undefined): RunConfig {
  const base = { concurrency: start?.concurrency ?? 0, skipInfo: false };
  if (!start?.agents) return { ...base, mode: "diff" };
  if (start.simulated) return { ...base, mode: "simulate" };
  const provider = (role: "worker" | "lead") => {
    const call = log.events.find((e) => e.type === "llm-call" && e.role === role);
    return call?.type === "llm-call" && call.provider === "ollama" ? "ollama" : "claude";
  };
  return { ...base, mode: provider("worker"), leadProvider: provider("lead") };
}

function logProgress(event: RunEvent) {
  switch (event.type) {
    case "run-start": return console.error(`Deterministic diff: ${event.units.length} changed units${event.simulated ? " (simulated agents)" : ""}`);
    case "unit-start": return console.error(event.question ? `  lead investigating ${event.unitId}: ${event.question}` : `  worker -> ${event.unitId}`);
    case "unit-failed": return console.error(`  worker FAILED ${event.unitId}: ${event.error}`);
    case "synthesis-start": return console.error("Lead agent synthesizing risks...");
    case "synthesis-failed": return console.error(`Lead agent FAILED: ${event.error}`);
    case "run-end": if (event.stopped) console.error(`Run stopped (${event.stopped})${event.error ? `: ${event.error}` : ""}`); return;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
