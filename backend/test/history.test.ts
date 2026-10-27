import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, discoverSpec, fetchSpec } from "../src/history/spec.js";
import { ApiTracker, REDACTED } from "../src/history/tracker.js";
import { startDashboardServer, type DashboardServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";

const V1 = readFileSync("backend/test/fixtures/petstore-v1.yaml", "utf8");
const V2 = readFileSync("backend/test/fixtures/petstore-v2.yaml", "utf8");

/** A live API whose spec can change between requests; records request headers. */
class FakeApi {
  server!: Server;
  url!: string;
  spec = V1;
  path = "/v3/api-docs";
  status = 200;
  seenHeaders: Record<string, string | string[] | undefined>[] = [];

  async start() {
    this.server = createServer((req, res) => {
      this.seenHeaders.push(req.headers);
      if (req.url !== this.path) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(this.status, { "content-type": "application/yaml" });
      res.end(this.spec);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
}

describe("spec fetching", () => {
  let api: FakeApi;
  beforeEach(async () => (api = await new FakeApi().start()));
  afterEach(() => new Promise<void>((r) => api.server.close(() => r())));

  it("hashes the same document identically regardless of format and key order", () => {
    const doc = parseYaml(V1);
    const reordered = Object.fromEntries(Object.entries(doc).reverse());
    expect(canonicalJson(reordered)).toBe(canonicalJson(doc));
    expect(canonicalJson(JSON.parse(JSON.stringify(doc)))).toBe(canonicalJson(doc));
  });

  it("fetches, parses and summarizes a YAML spec", async () => {
    const spec = await fetchSpec(`${api.url}/v3/api-docs`);
    expect(spec.summary).toEqual({ title: "Petstore", version: "1.0.0", specVersion: "2.0", paths: 2, operations: 4 });
    expect(spec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(spec.canonical).info.version).toBe("1.0.0");
  });

  it("finds the spec from the API's base URL", async () => {
    const found = await discoverSpec(api.url);
    expect(found.url).toBe(`${api.url}/v3/api-docs`);
  });

  it("explains what's wrong with a bad URL", async () => {
    await expect(fetchSpec(`${api.url}/nope`)).rejects.toThrow(/answered 404/);
    await expect(fetchSpec("file:///etc/passwd")).rejects.toThrow(/Only http\(s\) URLs/);
    api.spec = "<html>Swagger UI</html>";
    await expect(fetchSpec(`${api.url}/v3/api-docs`)).rejects.toThrow(/not a Swagger\/OpenAPI document/);
  });
});

describe("ApiTracker", () => {
  let api: FakeApi;
  let dir: string;
  let runs: RunManager;
  let clock: number;
  const tracker = () => new ApiTracker({ dir: join(dir, "apis"), runs, now: () => clock });

  beforeEach(async () => {
    api = await new FakeApi().start();
    dir = await mkdtemp(join(tmpdir(), "apiguardian-history-"));
    runs = await new RunManager({ runsDir: join(dir, "runs") }).init();
    clock = Date.parse("2026-10-20T10:00:00Z");
  });
  afterEach(async () => {
    await new Promise<void>((r) => api.server.close(() => r()));
    await rm(dir, { recursive: true });
  });

  it("builds a version history and reports each change", async () => {
    const t = await tracker().init();
    const created = await t.add({ url: api.url, headers: { Authorization: "Bearer s3cret" }, intervalMinutes: 30 });
    const id = created.api.id;

    // First fetch is the baseline: a snapshot, no report.
    expect(created.api).toMatchObject({ name: "Petstore", url: `${api.url}/v3/api-docs`, lastOutcome: "baseline", headers: { Authorization: REDACTED } });
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]!.runId).toBeUndefined();
    expect(api.seenHeaders.at(-1)!.authorization).toBe("Bearer s3cret");
    expect(statSync(join(dir, "apis", id, "api.json")).mode & 0o777).toBe(0o600);

    // Same spec again: logged, no new version.
    expect((await t.check(id)).outcome).toBe("unchanged");

    // The API evolves: new version + automatic report against the previous one.
    api.spec = V2;
    const changed = await t.check(id);
    expect(changed).toMatchObject({ outcome: "changed", trigger: "manual" });
    const run = await runs.waitForRun(changed.runId!);
    expect(run).toMatchObject({ status: "done", source: "tracker", origin: { apiId: id, apiName: "Petstore" } });
    expect(run!.summary).toMatchObject({ units: 6, breaking: 10 });

    const detail = await t.detail(id);
    expect(detail.versions.map((v) => v.summary.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(detail.versions[0]).toMatchObject({ previousId: detail.versions[1]!.id, runId: changed.runId });
    expect(detail.checks.map((c) => c.outcome)).toEqual(["changed", "unchanged", "baseline"]);

    // Any two versions can be compared on demand.
    const compared = await t.compare(id, detail.versions[0]!.id, detail.versions[1]!.id);
    expect((await runs.waitForRun(compared.id))!.status).toBe("done");

    // History survives a restart.
    const reloaded = await tracker().init();
    expect((await reloaded.detail(id)).versions).toHaveLength(2);
  });

  it("records failed checks without losing history", async () => {
    const t = await tracker().init();
    const { api: tracked } = await t.add({ url: `${api.url}/v3/api-docs` });
    api.status = 503;
    const failed = await t.check(tracked.id);
    expect(failed).toMatchObject({ outcome: "error", status: 503 });
    const detail = await t.detail(tracked.id);
    expect(detail.api.lastError).toMatch(/answered 503/);
    expect(detail.versions).toHaveLength(1);
  });

  it("checks APIs when their interval is due", async () => {
    const t = await tracker().init();
    const { api: hourly } = await t.add({ url: api.url, intervalMinutes: 60 });
    const { api: manual } = await t.add({ url: api.url, name: "Manual", intervalMinutes: 0 });
    expect(hourly.nextCheckAt).toBe("2026-10-20T11:00:00.000Z");
    expect(manual.nextCheckAt).toBeUndefined();

    clock += 30 * 60_000;
    expect(await t.tick()).toHaveLength(0);
    clock += 31 * 60_000;
    const due = await t.tick();
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ outcome: "unchanged", trigger: "schedule" });

    await t.update(hourly.id, { enabled: false });
    clock += 120 * 60_000;
    expect(await t.tick()).toHaveLength(0);
  });

  it("summarizes checks and the schedule across APIs for monitoring", async () => {
    const t = await tracker().init();
    const { api: hourly } = await t.add({ url: api.url, name: "Hourly", intervalMinutes: 60 });
    await t.add({ url: api.url, name: "Manual", intervalMinutes: 0 });
    clock += 61 * 60_000;
    await t.tick(); // unchanged
    api.spec = V2;
    clock += 61 * 60_000;
    await t.tick(); // changed
    api.status = 503;
    clock += 2 * 86_400_000; // two days later, outside a 1-day window
    await t.check(hourly.id);

    const week = await t.monitoring(7);
    expect(week.scheduler).toEqual({ running: false, tickMs: undefined });
    expect(week.daily).toHaveLength(7);
    expect(week.daily.at(-1)!.day).toBe("2026-10-22");
    expect(week.totalChecks).toBe(5);
    expect(week.checks[0]).toMatchObject({ apiName: "Hourly", outcome: "error", status: 503 });
    const h = week.apis.find((a) => a.name === "Hourly")!;
    expect(h).toMatchObject({ versions: 2, lastOutcome: "error", lastChangeAt: "2026-10-20T12:02:00.000Z", stats: { checks: 4, baseline: 1, unchanged: 1, changed: 1, error: 1 } });
    expect(h).not.toHaveProperty("headers");
    expect(week.daily.find((d) => d.day === "2026-10-20")).toMatchObject({ baseline: 2, unchanged: 1, changed: 1, error: 0 });

    const today = await t.monitoring(1, 1);
    expect(today.totalChecks).toBe(1);
    expect(today.checks).toHaveLength(1);
    expect(today.apis.find((a) => a.name === "Manual")!.stats.checks).toBe(0);

    t.startScheduler(60_000);
    expect((await t.monitoring()).scheduler).toEqual({ running: true, tickMs: 60_000 });
    t.stopScheduler();
  });

  it("keeps stored header values when the UI sends back redacted ones", async () => {
    const t = await tracker().init();
    const { api: tracked } = await t.add({ url: api.url, headers: { Authorization: "Bearer one" } });
    await t.update(tracked.id, { headers: { Authorization: REDACTED, "X-Extra": "two" } });
    await t.check(tracked.id);
    expect(api.seenHeaders.at(-1)).toMatchObject({ authorization: "Bearer one", "x-extra": "two" });
  });

  it("keeps separate worker and lead models, and clears what the settings form clears", async () => {
    const t = await tracker().init();
    const { api: tracked } = await t.add({ url: api.url, agents: { mode: "ollama", workerModel: "qwen3.5:4b", leadModel: "qwen3.5:9b" } });
    expect(tracked.agents).toMatchObject({ mode: "ollama", workerModel: "qwen3.5:4b", leadModel: "qwen3.5:9b" });

    // Local workers, Claude lead with its own model and effort.
    const mixed = await t.update(tracked.id, {
      agents: { mode: "ollama", concurrency: 2, skipInfo: false, workerModel: "qwen3.5:4b", leadProvider: "claude", leadModel: "claude-sonnet-5-5", leadEffort: "high" },
    });
    expect(mixed.api.agents).toEqual({ mode: "ollama", concurrency: 2, skipInfo: false, workerModel: "qwen3.5:4b", leadProvider: "claude", leadModel: "claude-sonnet-5-5", leadEffort: "high" });

    // Lead back to "same as workers" and default models: the old values must not linger.
    const cleared = await t.update(tracked.id, { agents: { mode: "ollama", concurrency: 2, skipInfo: false } });
    expect(cleared.api.agents).toEqual({ mode: "ollama", concurrency: 2, skipInfo: false });
  });

  it("rejects agent settings that could never run", async () => {
    const t = await tracker().init();
    await expect(t.add({ url: api.url, agents: { mode: "ollama", workerEndpoints: ["gpu9"] } })).rejects.toThrow(/Unknown Ollama endpoint/);
  });
});

describe("tracked API routes", () => {
  let api: FakeApi;
  let dir: string;
  let server: DashboardServer;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(new URL(path, server.url), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeEach(async () => {
    api = await new FakeApi().start();
    dir = await mkdtemp(join(tmpdir(), "apiguardian-routes-"));
    const runs = await new RunManager({ runsDir: join(dir, "runs") }).init();
    const tracker = await new ApiTracker({ dir: join(dir, "apis"), runs }).init();
    server = await startDashboardServer(runs, { port: 0, tracker });
  });
  afterEach(async () => {
    await server.close();
    await new Promise<void>((r) => api.server.close(() => r()));
    await rm(dir, { recursive: true });
  });

  it("adds, lists, checks and compares tracked APIs", async () => {
    const discovered = await (await call("/api/apis/discover", "POST", { url: api.url })).json();
    expect(discovered).toMatchObject({ url: `${api.url}/v3/api-docs`, summary: { version: "1.0.0" } });

    const created = await call("/api/apis", "POST", { url: api.url, headers: { Authorization: "Bearer x" }, intervalMinutes: 0 });
    expect(created.status).toBe(201);
    const { api: tracked } = await created.json();

    const list = await (await call("/api/apis")).json();
    expect(list).toEqual([expect.objectContaining({ id: tracked.id, versions: 1, headers: { Authorization: REDACTED } })]);

    api.spec = V2;
    const check = await (await call(`/api/apis/${tracked.id}/check`, "POST", {})).json();
    expect(check.outcome).toBe("changed");

    const detail = await (await call(`/api/apis/${tracked.id}`)).json();
    const [v2, v1] = detail.versions;
    const snapshot = await call(`/api/apis/${tracked.id}/snapshots/${v1.id}`);
    expect(JSON.parse(await snapshot.text()).info.version).toBe("1.0.0");
    expect((await call(`/api/apis/${tracked.id}/compare`, "POST", { from: v1.id, to: v2.id })).status).toBe(201);
  });

  it("returns useful errors", async () => {
    expect((await call("/api/apis", "POST", { url: `${api.url}/missing.json` })).status).toBe(422);
    expect((await call("/api/apis", "POST", { url: "ftp://x" })).status).toBe(422);
    expect((await call("/api/apis", "POST", { url: api.url, headers: { "bad header": "x" } })).status).toBe(400);
    expect((await call("/api/apis/nope")).status).toBe(404);
  });

  it("serves the monitoring summary", async () => {
    await call("/api/apis", "POST", { url: api.url, intervalMinutes: 0 });
    const res = await call("/api/monitoring?days=500");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowDays).toBe(90);
    expect(body.checks).toEqual([expect.objectContaining({ outcome: "baseline", trigger: "created" })]);
  });
});
