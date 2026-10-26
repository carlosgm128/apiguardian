import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentBackend } from "../src/agents/backend.js";
import { AppService } from "../src/apps/service.js";
import type { RunEvent } from "../src/events.js";
import { ApiTracker } from "../src/history/tracker.js";
import { compareDocs } from "../src/orchestrator.js";
import { startDashboardServer, type DashboardServer } from "../src/server/http.js";
import { RunManager, type RunConfig } from "../src/server/runs.js";

const V1_PATH = "backend/test/fixtures/petstore-v1.yaml";
const V2_PATH = "backend/test/fixtures/petstore-v2.yaml";

/**
 * leadModel "broken" fails like a small model running out of room;
 * workerModel "flaky" fails the GET /owners unit. Counts every call.
 */
function fakeBackends() {
  const calls = { workers: [] as string[], leads: 0 };
  const create = (config: RunConfig): AgentBackend | undefined =>
    config.mode === "diff" ? undefined : {
      async analyzeUnit(unit) {
        calls.workers.push(unit.id);
        if (config.workerModel === "flaky" && unit.id === "GET /owners") throw new Error("worker model unavailable");
        return { unitId: unit.id, summary: `analysis of ${unit.id} by ${config.workerModel ?? "default"}`, findings: [], risks: [] };
      },
      async synthesize(input) {
        calls.leads++;
        if (config.leadModel === "broken") throw new Error("qwen3.5:0.8b hit the output length limit");
        return {
          overview: `report by ${config.leadModel ?? "default"}`,
          risks: [{ title: "Auth now required", severity: "critical", likelihood: "high", description: "d", failureScenario: "401", affectedUnits: input.analyses.map((a) => a.unitId), mitigation: "m" }],
          crossCuttingNotes: [],
        };
      },
    };
  return { calls, create };
}

describe("reusing analyses in compareDocs", () => {
  it("reuses analyses and carries failures for a lead-only rerun", async () => {
    const { calls, create } = fakeBackends();
    const backend = create({ mode: "ollama", concurrency: 2, skipInfo: false })!;
    const events: RunEvent[] = [];
    const report = await compareDocs({
      baselinePath: V1_PATH,
      candidatePath: V2_PATH,
      backend,
      onEvent: (e) => events.push(e),
      reuse: {
        fromRunId: "run-1",
        analyses: { "GET /pets": { unitId: "GET /pets", summary: "earlier", findings: [], risks: [] } },
        rerunMissing: false,
        failures: [{ unitId: "POST /pets", error: "timeout" }],
      },
    });
    expect(calls.workers).toEqual([]);
    expect(calls.leads).toBe(1);
    expect(report.reusedUnits).toEqual(["GET /pets"]);
    expect(report.retryOf).toBe("run-1");
    expect(report.failedUnits).toContainEqual({ unitId: "POST /pets", error: "Not re-run: timeout" });
    expect(events.filter((e) => e.type === "unit-reused")).toHaveLength(1);
    expect(events.some((e) => e.type === "unit-skipped" && e.reason === "not-rerun")).toBe(true);
  });

  it("runs workers only for missing analyses when rerunning failed units", async () => {
    const { calls, create } = fakeBackends();
    const report = await compareDocs({
      baselinePath: V1_PATH,
      candidatePath: V2_PATH,
      backend: create({ mode: "ollama", concurrency: 2, skipInfo: false }),
      reuse: { fromRunId: "run-1", analyses: { "GET /pets": { unitId: "GET /pets", summary: "earlier", findings: [], risks: [] } }, rerunMissing: true },
    });
    expect(calls.workers).not.toContain("GET /pets");
    expect(calls.workers.length).toBe(report.diff.units.length - 1);
    expect(report.failedUnits).toEqual([]);
  });
});

describe("RunManager.retry", () => {
  let dir: string;
  let runs: RunManager;
  let fake: ReturnType<typeof fakeBackends>;
  const sample = (name: string) => ({ name: name.split("/").pop()!, content: readFileSync(name, "utf8") });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apiguardian-retry-"));
    fake = fakeBackends();
    runs = await new RunManager({ runsDir: join(dir, "runs"), createBackend: fake.create }).init();
  });
  afterEach(() => rm(dir, { recursive: true }));

  it("reruns only the lead with another model, reusing every worker analysis", async () => {
    const first = await runs.start({ baseline: sample(V1_PATH), candidate: sample(V2_PATH), config: { mode: "ollama", concurrency: 2, skipInfo: false, leadModel: "broken" } });
    const failed = await runs.waitForRun(first.id);
    expect(failed).toMatchObject({ status: "failed", error: "qwen3.5:0.8b hit the output length limit" });
    const workersBefore = fake.calls.workers.length;

    expect(await runs.retryInfo(first.id)).toMatchObject({ retryable: true, analyses: 6, failedUnits: 0, hasRiskReport: false, leadError: "qwen3.5:0.8b hit the output length limit" });

    const retry = await runs.retry(first.id, { scope: "lead", config: { leadModel: "qwen3.5:9b" } });
    const done = await runs.waitForRun(retry.id);
    expect(done).toMatchObject({ status: "done", retryOf: first.id, retryScope: "lead", config: { leadModel: "qwen3.5:9b", mode: "ollama" } });
    expect(fake.calls.workers.length).toBe(workersBefore); // no worker re-ran
    const report = await runs.report(retry.id);
    expect(report!.reusedUnits).toHaveLength(6);
    expect(report!.riskReport!.overview).toBe("report by qwen3.5:9b");
    expect(runs.get(first.id)!.retriedBy).toEqual([retry.id]);

    // The new run's event log says the analyses were reused; it records no new worker calls.
    const log = await runs.events(retry.id);
    expect(log!.events.filter((e) => e.type === "unit-reused")).toHaveLength(6);
    expect(log!.events.filter((e) => e.type === "unit-start")).toHaveLength(0);
  });

  it("reruns just the failed workers, with a different worker model", async () => {
    const first = await runs.start({ baseline: sample(V1_PATH), candidate: sample(V2_PATH), config: { mode: "ollama", concurrency: 2, skipInfo: false, workerModel: "flaky" } });
    await runs.waitForRun(first.id);
    expect((await runs.report(first.id))!.failedUnits.map((f) => f.unitId)).toEqual(["GET /owners"]);

    fake.calls.workers.length = 0;
    const retry = await runs.retry(first.id, { scope: "failed", config: { workerModel: "steady" } });
    await runs.waitForRun(retry.id);
    expect(fake.calls.workers).toEqual(["GET /owners"]);
    const report = await runs.report(retry.id);
    expect(report!.failedUnits).toEqual([]);
    expect(report!.analyses["GET /owners"]!.summary).toBe("analysis of GET /owners by steady");
  });

  it("explains when a scope can't apply", async () => {
    const diffOnly = await runs.start({ baseline: sample(V1_PATH), candidate: sample(V2_PATH), config: { mode: "diff", concurrency: 1, skipInfo: false } });
    await runs.waitForRun(diffOnly.id);
    await expect(runs.retry(diffOnly.id, { scope: "lead", config: { mode: "ollama" } })).rejects.toThrow(/no worker analyses to reuse/);
    await expect(runs.retry(diffOnly.id, { scope: "lead" })).rejects.toThrow(/Choose an agent provider/);
    // "all" upgrades a diff-only run to one with agents.
    const upgraded = await runs.retry(diffOnly.id, { scope: "all", config: { mode: "ollama" } });
    expect((await runs.waitForRun(upgraded.id))!.status).toBe("done");
    await expect(runs.retry("nope", { scope: "all" })).rejects.toThrow(/No run/);
  });
});

describe("rerunning a tracked API's report", () => {
  let dir: string;
  let api: Server;
  let hooks: Server;
  let hookCount = 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apiguardian-retry-apps-"));
    let spec = readFileSync(V1_PATH, "utf8");
    api = createServer((_req, res) => res.end(spec));
    (api as Server & { setSpec?: (s: string) => void }).setSpec = (s) => (spec = s);
    hooks = createServer((req, res) => {
      hookCount++;
      req.resume();
      res.end();
    });
    await Promise.all([api, hooks].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  });
  afterEach(async () => {
    await Promise.all([api, hooks].map((s) => new Promise<void>((r) => s.close(() => r()))));
    await rm(dir, { recursive: true });
  });

  it("replaces the change's impacts with the rerun's, without notifying again", async () => {
    const fake = fakeBackends();
    const runs = await new RunManager({ runsDir: join(dir, "runs"), createBackend: fake.create }).init();
    const tracker = await new ApiTracker({ dir: join(dir, "apis"), runs }).init();
    const apps = await new AppService({ dir: join(dir, "apps"), runs, tracker, deliverOptions: { retryDelayMs: 1 } }).init();
    const port = (s: Server) => (s.address() as AddressInfo).port;

    const { api: tracked } = await tracker.add({ url: `http://127.0.0.1:${port(api)}/openapi.yaml`, intervalMinutes: 0, agents: { mode: "ollama", leadModel: "broken" } });
    const channel = await apps.createChannel({ name: "hook", type: "webhook", url: `http://127.0.0.1:${port(hooks)}/` });
    await apps.createApp({ name: "Shop", dependencies: [{ apiId: tracked.id, operations: "all" }], channelIds: [channel.id] });

    (api as Server & { setSpec: (s: string) => void }).setSpec(readFileSync(V2_PATH, "utf8"));
    const check = await tracker.check(tracked.id);
    await runs.waitForRun(check.runId!);
    expect(hookCount).toBe(1); // the change is announced even though the lead failed
    expect(apps.impactsFor({})[0]!.risks).toEqual([]);

    const retry = await runs.retry(check.runId!, { scope: "lead", config: { leadModel: "qwen3.5:9b" } });
    await runs.waitForRun(retry.id);

    const impacts = apps.impactsFor({});
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ runId: retry.id });
    expect(impacts[0]!.risks.map((r) => r.title)).toEqual(["Auth now required"]);
    expect(hookCount).toBe(1); // no second notification
    expect((await tracker.detail(tracked.id)).versions[0]!.runId).toBe(retry.id);
  });
});

describe("retry routes", () => {
  let dir: string;
  let server: DashboardServer;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apiguardian-retry-routes-"));
    const runs = await new RunManager({ runsDir: join(dir, "runs"), samplesDir: "backend/test/fixtures", createBackend: fakeBackends().create }).init();
    server = await startDashboardServer(runs, { port: 0 });
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true });
  });

  it("reports what can be reused and starts reruns", async () => {
    const post = (path: string, body: unknown) => fetch(new URL(path, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = await (await post("/api/runs", { sample: "petstore", mode: "ollama", leadModel: "broken" })).json();
    for (let i = 0; i < 100 && (await (await fetch(new URL(`/api/runs/${run.id}`, server.url))).json()).status === "running"; i++) await new Promise((r) => setTimeout(r, 10));

    const info = await (await fetch(new URL(`/api/runs/${run.id}/retry-info`, server.url))).json();
    expect(info).toMatchObject({ retryable: true, analyses: 6 });
    expect((await post(`/api/runs/${run.id}/retry`, { scope: "sideways" })).status).toBe(400);
    const retried = await post(`/api/runs/${run.id}/retry`, { scope: "lead", config: { leadModel: "big" } });
    expect(retried.status).toBe(201);
    expect((await retried.json()).retryOf).toBe(run.id);
  });
});
