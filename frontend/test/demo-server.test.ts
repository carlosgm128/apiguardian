import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../src/demo/seed.json";
import { DemoServer, type DemoNotice } from "../src/demo/server";
import type { DemoRecording, DemoSeed } from "../src/demo/types";
import type { CheckRecord, Delivery, ImpactRecord, RunEvent, RunMeta } from "../src/types";

const recording = JSON.parse(readFileSync(new URL("../src/demo/recording.json", import.meta.url), "utf8")) as DemoRecording;

let server: DemoServer;
let notices: DemoNotice[];

beforeEach(() => {
  vi.useFakeTimers();
  server = new DemoServer(recording, seed as unknown as DemoSeed);
  notices = [];
  server.onNotice((n) => notices.push(n));
});

afterEach(() => {
  server.dispose();
  vi.useRealTimers();
});

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await server.handle(method, url, body);
  if (res.status >= 400) throw new Error((res.body as { error: string }).error);
  return (res.text ?? res.body) as T;
}

async function finish(id: string): Promise<RunMeta> {
  await vi.advanceTimersByTimeAsync(60_000);
  return call<RunMeta>("GET", `/api/runs/${id}`);
}

const leadFailedId = recording.runs["lead-failed"].meta.id;

describe("demo server", () => {
  it("starts with a few days of recorded history", async () => {
    const runs = await call<RunMeta[]>("GET", "/api/runs");
    expect(runs.map((r) => r.id)).toEqual([leadFailedId, recording.runs["petstore-gpu"].meta.id, recording.runs["tracker-1"].meta.id, recording.runs["docs-ollama"].meta.id]);
    expect(Date.parse(runs[0]!.createdAt)).toBeLessThan(Date.now());
    const info = await call<{ analyses: number; leadError?: string }>("GET", `/api/runs/${leadFailedId}/retry-info`);
    expect(info.analyses).toBe(6);
    expect(info.leadError).toMatch(/output length limit/);
  });

  it("streams a new run's events and finishes with the recording's report", async () => {
    const meta = await call<RunMeta>("POST", "/api/runs", { sample: "petstore", mode: "ollama", concurrency: 2, skipInfo: false });
    expect(meta.status).toBe("running");
    const seen: RunEvent[] = [];
    server.subscribe(meta.id, (e) => seen.push(e));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(recording.runs["petstore-ollama"].events.length);
    const done = await finish(meta.id);
    expect(done.status).toBe("done");
    expect(done.summary.risks).toBe(21);
    expect(seen.at(-1)?.type).toBe("run-end");
    // Replays are compressed to about 25 seconds.
    expect(done.summary.durationMs).toBeLessThanOrEqual(26_000);
  });

  it("reruns only the lead of the failed run, reusing the worker analyses", async () => {
    const rerun = await call<RunMeta>("POST", `/api/runs/${leadFailedId}/retry`, { scope: "lead", config: { leadModel: "qwen3.5:4b" } });
    const events: RunEvent[] = [];
    server.subscribe(rerun.id, (e) => events.push(e));
    const done = await finish(rerun.id);
    expect(done).toMatchObject({ status: "done", retryOf: leadFailedId, retryScope: "lead" });
    expect(events.filter((e) => e.type === "unit-reused")).toHaveLength(6);
    expect(events.filter((e) => e.type === "llm-call").every((e) => e.type === "llm-call" && e.role === "lead")).toBe(true);
    expect(done.summary.risks).toBe(12);
    expect((await call<RunMeta>("GET", `/api/runs/${leadFailedId}`)).retriedBy).toEqual([rerun.id]);
  });

  it("builds a lead-only rerun for other runs from their own recording", async () => {
    const id = recording.runs["petstore-gpu"].meta.id;
    const rerun = await call<RunMeta>("POST", `/api/runs/${id}/retry`, { scope: "lead" });
    const events: RunEvent[] = [];
    server.subscribe(rerun.id, (e) => events.push(e));
    const done = await finish(rerun.id);
    expect(done.status).toBe("done");
    expect(events.filter((e) => e.type === "unit-reused")).toHaveLength(6);
    expect(events.some((e) => e.type === "llm-call" && e.role === "worker" && !e.unitId)).toBe(false);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("finds a new version on Check now, reports it, and notifies the affected applications", async () => {
    const check = await call<CheckRecord>("POST", "/api/apis/petstore/check");
    expect(check.outcome).toBe("changed");
    const detail = await call<{ versions: { summary: { version: string }; runId?: string }[] }>("GET", "/api/apis/petstore");
    expect(detail.versions[0]!.summary.version).toBe("2.1.0");
    expect(detail.versions[0]!.runId).toBe(check.runId);

    await finish(check.runId!);
    const owner = await call<{ impacts: ImpactRecord[] }>("GET", "/api/apps/owner-portal");
    expect(owner.impacts[0]).toMatchObject({ runId: check.runId, worst: "breaking", to: { version: "2.1.0" } });
    const deliveries = await call<Delivery[]>("GET", "/api/deliveries");
    expect(deliveries.map((d) => d.channelId).sort()).toEqual(["api-alerts", "mobile-team", "owner-portal-ci"]);
    // Storefront web saw info-level changes only, below its threshold.
    expect(deliveries.some((d) => d.appId === "storefront-web")).toBe(false);
    const slack = notices.find((n) => n.payload && n.title.startsWith("#api-alerts"));
    expect(slack?.payload?.body).toContain(check.runId);

    const apps = await call<{ tracked: boolean; applications: { name: string }[] }>("GET", `/api/runs/${check.runId}/applications`);
    expect(apps.applications.map((a) => a.name).sort()).toEqual(["Mobile app", "Owner portal", "Storefront web"]);
    expect(await call<string>("GET", `/api/runs/${check.runId}/report.md`)).toContain("Applications affected");

    expect((await call<CheckRecord>("POST", "/api/apis/petstore/check")).outcome).toBe("unchanged");
  });

  it("backfills a new application and exports reports", async () => {
    const { impacts } = await call<{ impacts: ImpactRecord[] }>("POST", "/api/apps", { name: "Checkout", dependencies: [{ apiId: "petstore", operations: ["post /pets"] }] });
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.changes.every((c) => c.unitId === "POST /pets" || c.unitId === "spec:global")).toBe(true);
    const csv = await call<string>("GET", "/api/reports/breaking?app=" + impacts[0]!.appId + "&format=csv");
    expect(csv.split("\n")[0]).toBe("date,application,api,from_version,to_version,severity,location,change,run_id");
    await expect(call("POST", "/api/apps", { name: "Bad", dependencies: [{ apiId: "nope", operations: "all" }] })).rejects.toThrow(/Unknown tracked API/);
  });

  it("masks channel secrets and refuses what the demo can't do", async () => {
    const channels = await call<{ id: string; url: string; token?: string }[]>("GET", "/api/channels");
    const github = channels.find((c) => c.id === "owner-portal-ci")!;
    expect(github.url).toBe("https://api.github.com/••••••");
    expect(github.token).toBe("••••••");
    await expect(call("POST", "/api/runs", { sample: "petstore", mode: "claude", concurrency: 2, skipInfo: false })).rejects.toThrow(/no Claude/);
    await expect(call("POST", "/api/runs", { baseline: { name: "a.yaml", content: "" }, candidate: { name: "b.yaml", content: "" }, mode: "diff", concurrency: 2, skipInfo: false })).rejects.toThrow(/pick a sample/);
    const tracker1 = recording.runs["tracker-1"].meta.id;
    await expect(call("POST", `/api/runs/${tracker1}/retry`, { scope: "lead", config: { mode: "ollama" } })).rejects.toThrow(/no worker analyses/);
  });

  it("cancels a replay", async () => {
    const meta = await call<RunMeta>("POST", "/api/runs", { sample: "docs", mode: "simulate", concurrency: 2, skipInfo: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await server.handle("POST", `/api/runs/${meta.id}/cancel`)).status).toBe(202);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await call<RunMeta>("GET", `/api/runs/${meta.id}`)).status).toBe("cancelled");
  });
});
