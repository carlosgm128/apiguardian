import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatedBackend } from "../src/agents/simulated.js";
import { EventLog, type RunEvent } from "../src/events.js";
import { startDashboardServer, type DashboardServer } from "../src/server/http.js";
import { RunManager, type RunMeta } from "../src/server/runs.js";

const fast = (delay = 1) => new SimulatedBackend({ minDelayMs: delay, maxDelayMs: delay, seed: 3 });

/** Reads SSE `data:` payloads until `stop` returns true. */
async function readEvents(url: string, stop: (events: RunEvent[]) => boolean): Promise<RunEvent[]> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: RunEvent[] = [];
  let buffer = "";
  while (!stop(out)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (chunk.startsWith("data: ")) out.push(JSON.parse(chunk.slice(6)));
    }
  }
  controller.abort();
  return out;
}

const ended = (events: RunEvent[]) => events.some((e) => e.type === "run-end");

async function waitForStatus(server: DashboardServer, id: string, status: string): Promise<RunMeta> {
  for (let i = 0; i < 200; i++) {
    const meta = (await (await fetch(new URL(`/api/runs/${id}`, server.url))).json()) as RunMeta;
    if (meta.status === status) return meta;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${id} never reached ${status}`);
}

describe("dashboard server", () => {
  let dir: string;
  let server: DashboardServer;
  let delay = 1;
  const post = (path: string, body: unknown) =>
    fetch(new URL(path, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apiguardian-"));
    const manager = await new RunManager({ runsDir: join(dir, "runs"), samplesDir: "backend/test/fixtures", createBackend: (c) => (c.mode === "diff" ? undefined : fast(delay)) }).init();
    server = await startDashboardServer(manager, { port: 0 });
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true });
    delay = 1;
  });

  it("lists the bundled sample pairs", async () => {
    const status = await (await fetch(new URL("/api/status", server.url))).json();
    expect(status.samples.map((s: { id: string }) => s.id)).toEqual(["docs", "petstore"]);
    expect(typeof status.credentials).toBe("boolean");
  });

  it("starts a run, streams its events and serves the report", async () => {
    const res = await post("/api/runs", { sample: "petstore", mode: "simulate", concurrency: 2 });
    expect(res.status).toBe(201);
    const run = (await res.json()) as RunMeta;
    expect(run).toMatchObject({ status: "running", source: "dashboard", baselineName: "petstore-v1.yaml" });

    const events = await readEvents(new URL(`/api/runs/${run.id}/events`, server.url).href, ended);
    expect(events[0]!.type).toBe("run-start");
    const call = events.find((e) => e.type === "llm-call");
    expect(call).toMatchObject({ prompt: { user: expect.stringContaining("<unit") }, output: expect.stringContaining("summary") });

    const done = await waitForStatus(server, run.id, "done");
    expect(done.summary).toMatchObject({ units: 6, breaking: 10, failedUnits: 0 });
    expect(done.summary.llmCalls).toBeGreaterThan(6);

    const list = (await (await fetch(new URL("/api/runs", server.url))).json()) as RunMeta[];
    expect(list.map((r) => r.id)).toEqual([run.id]);
    expect((await (await fetch(new URL(`/api/runs/${run.id}/report`, server.url))).json()).simulated).toBe(true);
    const md = await fetch(new URL(`/api/runs/${run.id}/report.md`, server.url));
    expect(md.headers.get("content-disposition")).toContain("attachment");
  });

  it("accepts uploaded files", async () => {
    const res = await post("/api/runs", {
      baseline: { name: "a.md", content: "# API\n\n`GET /a`" },
      candidate: { name: "b.md", content: "# API\n\n`GET /b`" },
      mode: "diff",
    });
    const run = (await res.json()) as RunMeta;
    const done = await waitForStatus(server, run.id, "done");
    expect(done.summary.units).toBe(1);
  });

  it("cancels a running run", async () => {
    delay = 200;
    const run = (await (await post("/api/runs", { sample: "petstore", mode: "simulate", concurrency: 1 })).json()) as RunMeta;
    expect((await post(`/api/runs/${run.id}/cancel`, {})).status).toBe(202);
    const meta = await waitForStatus(server, run.id, "cancelled");
    const report = await (await fetch(new URL(`/api/runs/${run.id}/report`, server.url))).json();
    expect(report.stopped).toEqual({ reason: "cancelled" });
    expect(report.notRunUnits.length).toBeGreaterThan(0);
    expect(meta.summary.risks).toBeUndefined();
    expect((await post(`/api/runs/${run.id}/cancel`, {})).status).toBe(409);
  });

  it("rejects invalid requests", async () => {
    expect((await post("/api/runs", { mode: "simulate" })).status).toBe(400);
    expect((await post("/api/runs", { sample: "nope", mode: "simulate" })).status).toBe(400);
    const bad = await post("/api/runs", { baseline: { name: "a.txt", content: "" }, candidate: { name: "b.txt", content: "" }, mode: "diff" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Unsupported file type/);
    expect((await fetch(new URL("/api/runs/missing", server.url))).status).toBe(404);
  });

  it("reports compute and validates endpoint ids", async () => {
    const compute = await (await fetch(new URL("/api/compute", server.url))).json();
    expect(typeof compute.gpus.available).toBe("boolean");
    expect(compute.endpoints.map((e: { id: string }) => e.id)).toEqual(["default"]);
    expect(typeof compute.endpoints[0].reachable).toBe("boolean");

    const bad = await post("/api/runs", { sample: "docs", mode: "ollama", workerEndpoints: ["gpu9"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Unknown Ollama endpoint "gpu9"/);
  });

  it("rejects non-loopback Host and Origin headers", async () => {
    const { port } = new URL(server.url);
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/runs", method: "GET", headers }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await status({ host: "evil.example" })).toBe(403);
    expect(await status({ host: `127.0.0.1:${port}`, origin: "https://evil.example" })).toBe(403);
    expect(await status({ host: `localhost:${port}`, origin: `http://localhost:5173` })).toBe(200);
  });

  it("reloads finished runs after a restart", async () => {
    const run = (await (await post("/api/runs", { sample: "docs", mode: "simulate" })).json()) as RunMeta;
    await waitForStatus(server, run.id, "done");

    const reloaded = await new RunManager({ runsDir: join(dir, "runs") }).init();
    expect(reloaded.get(run.id)).toMatchObject({ status: "done", baselineName: "docs-v1.md" });
    const log = await reloaded.events(run.id);
    expect(log!.events.at(-1)!.type).toBe("run-end");
  });
});

describe("EventLog", () => {
  it("round-trips through events.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "apiguardian-"));
    const event = (seq: number): RunEvent => ({ type: "synthesis-start", seq, t: 1000 + seq });
    try {
      const file = join(dir, "events.jsonl");
      const log = new EventLog();
      log.record(event(1));
      log.writeTo(file); // history written on attach
      log.record(event(2));
      await log.close();
      expect((await EventLog.load(file)).events).toEqual([event(1), event(2)]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
