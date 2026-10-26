import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeImpact, operationKey, parseOperationList } from "../src/apps/impact.js";
import { buildRequest, deliver, sign, type NotificationEvent } from "../src/apps/notify.js";
import { AppService, REDACTED } from "../src/apps/service.js";
import type { Application, Channel, ImpactRecord } from "../src/apps/types.js";
import { ApiTracker } from "../src/history/tracker.js";
import { compareDocs } from "../src/orchestrator.js";
import { startDashboardServer, type DashboardServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";

const V1 = readFileSync("backend/test/fixtures/petstore-v1.yaml", "utf8");
const V2 = readFileSync("backend/test/fixtures/petstore-v2.yaml", "utf8");

/** Serves a spec that can change between requests (a "live" API). */
async function evolvingApi() {
  const state = { spec: V1 };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/yaml" });
    res.end(state.spec);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { state, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.yaml` };
}

/** Records POSTs; answers with the next scripted status (default 200). */
async function receiver() {
  const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const statuses: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    got.push({ headers: req.headers, body });
    res.writeHead(statuses.shift() ?? 200);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { got, statuses, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` };
}

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe("operation keys", () => {
  it("normalizes the ways people write operations", () => {
    expect(operationKey("GET /pets/{petId}")).toBe("GET /pets/{}");
    expect(operationKey("delete /pets/:id")).toBe("DELETE /pets/{}");
    expect(operationKey("POST https://api.example.com/pets?x=1")).toBe("POST /pets");
    expect(operationKey("FETCH /pets")).toBeNull();
    expect(operationKey("/pets")).toBeNull();
    expect(parseOperationList("GET /pets\n# comment\n\nget /pets\nnot an op")).toEqual({ keys: ["GET /pets"], invalid: ["not an op"] });
  });
});

describe("impact", async () => {
  const report = await compareDocs({ baselinePath: "backend/test/fixtures/petstore-v1.yaml", candidatePath: "backend/test/fixtures/petstore-v2.yaml" });
  const ctx = { runId: "r1", at: "2026-10-20T00:00:00Z", apiId: "pets", apiName: "Petstore", from: { id: "0001-a", seq: 1, version: "1.0.0" }, to: { id: "0002-b", seq: 2, version: "2.0.0" } };
  const app = (operations: "all" | string[]): Application => ({ id: "a", name: "Shop", dependencies: [{ apiId: "pets", operations }], channelIds: [], minSeverity: "breaking", createdAt: "" });

  it("limits an application's impact to the operations it uses, plus spec-wide changes", () => {
    const deleting = computeImpact(app(["DELETE /pets/{}"]), report, ctx)!;
    expect(new Set(deleting.changes.map((c) => c.unitId))).toEqual(new Set(["DELETE /pets/{}", "spec:global"]));
    expect(deleting.changes.find((c) => c.unitId === "DELETE /pets/{}")?.message).toBe("Operation was removed");
    expect(deleting.worst).toBe("breaking");

    const all = computeImpact(app("all"), report, ctx)!;
    expect(all.changes.length).toBe(report.diff.units.flatMap((u) => u.changes).length);
    expect(computeImpact({ ...app("all"), dependencies: [{ apiId: "other", operations: "all" }] }, report, ctx)).toBeUndefined();
  });
});

describe("notification formats", () => {
  const impact: ImpactRecord = {
    id: "r1:a", at: "2026-10-20T00:00:00Z", runId: "r1", appId: "a", appName: "Shop", apiId: "pets", apiName: "Petstore",
    from: { id: "1", seq: 1, version: "1.0.0" }, to: { id: "2", seq: 2, version: "2.0.0" },
    counts: { breaking: 1, warning: 0, info: 0 }, worst: "breaking",
    changes: [{ id: "c1", unitId: "GET /pets", severity: "breaking", location: "GET /pets > security", message: "<!channel> @everyone auth now required" }],
    risks: [{ title: "401s everywhere", severity: "critical", failureScenario: "x", mitigation: "y" }],
  };
  const app: Application = { id: "a", name: "Shop", dependencies: [], channelIds: [], minSeverity: "breaking", createdAt: "" };
  const event: NotificationEvent = { kind: "impact", app, impact, reportUrl: "http://127.0.0.1:4319/#/runs/r1" };
  const channel = (type: Channel["type"], extra: Partial<Channel> = {}): Channel => ({ id: "c", name: "c", type, url: "https://hooks.example.com/x", enabled: true, createdAt: "", ...extra });

  it("Slack: escapes doc text so it can't mention the channel", () => {
    const body = JSON.parse(buildRequest(channel("slack"), event).body);
    const text = JSON.stringify(body.blocks);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).not.toContain("<!channel>");
    expect(body.text).toContain("Shop: Petstore v1.0.0 (#1) → v2.0.0 (#2) has 1 breaking change in operations it uses");
    expect(body.blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ url: "http://127.0.0.1:4319/#/runs/r1" }] });
  });

  it("Teams: sends an Adaptive Card", () => {
    const body = JSON.parse(buildRequest(channel("teams"), event).body);
    expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(body.attachments[0].content).toMatchObject({ type: "AdaptiveCard", version: "1.4", actions: [{ type: "Action.OpenUrl" }] });
  });

  it("Discord: disables mentions", () => {
    const body = JSON.parse(buildRequest(channel("discord"), event).body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0].description).not.toMatch(/@everyone/);
  });

  it("Webhook: JSON payload with a verifiable HMAC signature and custom headers", () => {
    const req = buildRequest(channel("webhook", { secret: "k", headers: { "X-Team": "payments" } }), event);
    expect(req.headers["x-apiguardian-signature"]).toBe(`sha256=${sign("k", req.body)}`);
    expect(req.headers["X-Team"]).toBe("payments");
    expect(JSON.parse(req.body)).toMatchObject({ event: "api.change.impact", severity: "breaking", application: { name: "Shop" }, counts: { breaking: 1 } });
  });

  it("GitHub: repository_dispatch with a token", () => {
    const req = buildRequest(channel("github", { token: "ghp_x", eventType: "api-break" }), event);
    expect(req.headers.authorization).toBe("Bearer ghp_x");
    const body = JSON.parse(req.body);
    expect(body.event_type).toBe("api-break");
    expect(Object.keys(body.client_payload).length).toBeLessThanOrEqual(10);
  });

  it("GitLab: pipeline trigger form with variables", () => {
    const form = new URLSearchParams(buildRequest(channel("gitlab", { token: "glptt-x", ref: "release" }), event).body);
    expect(form.get("token")).toBe("glptt-x");
    expect(form.get("ref")).toBe("release");
    expect(form.get("variables[APIGUARDIAN_BREAKING]")).toBe("1");
    expect(form.get("variables[APIGUARDIAN_APP]")).toBe("Shop");
  });

  it("retries once on server errors, not on client errors", async () => {
    const r = await receiver();
    try {
      r.statuses.push(503, 200);
      const ok = await deliver(channel("webhook", { url: r.url }), event, { retryDelayMs: 1 });
      expect(ok).toMatchObject({ ok: true, attempts: 2, status: 200 });
      r.statuses.push(400);
      const bad = await deliver(channel("webhook", { url: r.url }), event, { retryDelayMs: 1 });
      expect(bad).toMatchObject({ ok: false, attempts: 1, status: 400 });
    } finally {
      await close(r.server);
    }
  });
});

describe("AppService", () => {
  let dir: string;
  let api: Awaited<ReturnType<typeof evolvingApi>>;
  let hook: Awaited<ReturnType<typeof receiver>>;
  let runs: RunManager;
  let tracker: ApiTracker;
  let apps: AppService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apiguardian-apps-"));
    api = await evolvingApi();
    hook = await receiver();
    runs = await new RunManager({ runsDir: join(dir, "runs") }).init();
    tracker = await new ApiTracker({ dir: join(dir, "apis"), runs }).init();
    apps = await new AppService({ dir: join(dir, "apps"), runs, tracker, publicUrl: "http://dash.local", deliverOptions: { retryDelayMs: 1 } }).init();
  });
  afterEach(async () => {
    await close(api.server);
    await close(hook.server);
    await rm(dir, { recursive: true });
  });

  it("notifies an affected application when a tracked API changes, and builds its history", async () => {
    const { api: tracked } = await tracker.add({ url: api.url, intervalMinutes: 0 });
    const channel = await apps.createChannel({ name: "payments-alerts", type: "webhook", url: hook.url, secret: "s3cret" });
    expect(channel).toMatchObject({ url: `${new URL(hook.url).origin}/${REDACTED}`, secret: REDACTED });
    expect(statSync(join(dir, "apps", "channels.json")).mode & 0o777).toBe(0o600);

    const shop = await apps.createApp({ name: "Shop", owner: "payments", dependencies: [{ apiId: tracked.id, operations: ["delete /pets/{id}"] }], channelIds: [channel.id] });
    expect(shop.app.dependencies[0]!.operations).toEqual(["DELETE /pets/{}"]);
    expect(shop.impacts).toEqual([]); // no changes yet

    api.state.spec = V2;
    const check = await tracker.check(tracked.id);
    await runs.waitForRun(check.runId!);

    expect(hook.got).toHaveLength(1);
    const payload = JSON.parse(hook.got[0]!.body);
    expect(hook.got[0]!.headers["x-apiguardian-signature"]).toBe(`sha256=${sign("s3cret", hook.got[0]!.body)}`);
    expect(payload).toMatchObject({
      event: "api.change.impact",
      severity: "breaking",
      application: { name: "Shop", owner: "payments" },
      versions: { from: { seq: 1, version: "1.0.0" }, to: { seq: 2, version: "2.0.0" } },
      reportUrl: `http://dash.local/#/runs/${check.runId}`,
    });
    expect(payload.changes.map((c: { location: string }) => c.location)).toContain("DELETE /pets/{}");
    expect((await apps.deliveries())[0]).toMatchObject({ ok: true, appId: shop.app.id, channelName: "payments-alerts" });

    // An application added later gets its history computed from past changes, without notifications.
    const late = await apps.createApp({ name: "Admin", dependencies: [{ apiId: tracked.id, operations: "all" }], channelIds: [channel.id] });
    expect(late.impacts).toHaveLength(1);
    expect(hook.got).toHaveLength(1);

    // Comparing two versions on demand is not a new change: no impacts, no notifications.
    const [v2, v1] = (await tracker.detail(tracked.id)).versions;
    await runs.waitForRun((await tracker.compare(tracked.id, v1!.id, v2!.id)).id);
    expect(apps.impactsFor({})).toHaveLength(2);
    expect(hook.got).toHaveLength(1);

    const md = apps.reportMarkdown({ minSeverity: "breaking" });
    expect(md).toContain("| Shop | 1 |");
    expect(md).toContain("`DELETE /pets/{}`: Operation was removed");
    const csv = apps.reportCsv({ appId: shop.app.id });
    expect(csv.split("\n")[0]).toBe("date,application,api,from_version,to_version,severity,location,change,run_id");
    expect(csv).toContain("DELETE /pets/{},Operation was removed");

    // The run's report starts with a short summary: changed endpoints and who they affect.
    const runReport = await apps.renderRunReport(check.runId!);
    const summary = runReport!.slice(runReport!.indexOf("## Summary"), runReport!.indexOf("## What could fail"));
    expect(runReport!.indexOf("## Summary")).toBeLessThan(runReport!.indexOf("## What could fail"));
    expect(summary).toContain("**2 applications affected**");
    expect(summary).toMatch(/\| DELETE \/pets\/\{id\} \| removed \| 1 \| 0 \| 0 \| Shop, Admin \|/);
    expect(summary).toMatch(/\| GET \/owners \| added \| 0 \| 0 \| 1 \| Admin \|/); // only Admin uses every operation
    expect(summary).toContain("### Applications affected");
    expect(summary).toMatch(/\| Shop \| payments \| (Spec-wide settings \(servers, security schemes, version\), DELETE \/pets\/\{id\}|DELETE \/pets\/\{id\}, Spec-wide settings \(servers, security schemes, version\)) \|/);
    // The file in the run folder was refreshed with the applications too.
    const onDisk = readFileSync(join(dir, "runs", check.runId!, "report.md"), "utf8");
    expect(onDisk).toContain("### Applications affected");
  });

  it("says when a run can't be matched to applications", async () => {
    const report = await compareDocs({ baselinePath: "backend/test/fixtures/petstore-v1.yaml", candidatePath: "backend/test/fixtures/petstore-v2.yaml" });
    const { renderMarkdownReport } = await import("../src/report/markdown.js");
    const md = renderMarkdownReport(report);
    expect(md).toContain("## Summary");
    expect(md).toContain("10 breaking**, 4 warning and 13 info changes in 6 endpoints.");
    expect(md).toContain("Applications are matched only for tracked APIs");
    expect(md).not.toContain("Applications affected |");
  });

  it("keeps stored secrets when the UI sends redacted values back", async () => {
    const channel = await apps.createChannel({ name: "c", type: "webhook", url: hook.url, secret: "original" });
    await apps.updateChannel(channel.id, { name: "renamed", url: REDACTED, secret: REDACTED });
    const test = await apps.testChannel(channel.id);
    expect(test).toMatchObject({ ok: true, test: true });
    expect(hook.got[0]!.headers["x-apiguardian-signature"]).toBe(`sha256=${sign("original", hook.got[0]!.body)}`);
    expect(apps.listChannels()[0]!.name).toBe("renamed");
  });

  it("validates input", async () => {
    await expect(apps.createApp({ name: "x", dependencies: [{ apiId: "nope", operations: "all" }] })).rejects.toThrow(/Unknown tracked API/);
    await expect(apps.createChannel({ name: "s", type: "slack", url: "http://hooks.slack.com/x" })).rejects.toThrow(/https/);
    await expect(apps.createChannel({ name: "g", type: "github", url: "https://api.github.com/repos/o/r/dispatches" })).rejects.toThrow(/token/);
  });
});

describe("application routes", () => {
  let dir: string;
  let api: Awaited<ReturnType<typeof evolvingApi>>;
  let server: DashboardServer;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(new URL(path, server.url), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apiguardian-approutes-"));
    api = await evolvingApi();
    const runs = await new RunManager({ runsDir: join(dir, "runs") }).init();
    const tracker = await new ApiTracker({ dir: join(dir, "apis"), runs }).init();
    const apps = await new AppService({ dir: join(dir, "apps"), runs, tracker }).init();
    server = await startDashboardServer(runs, { port: 0, tracker, apps });
  });
  afterEach(async () => {
    await server.close();
    await close(api.server);
    await rm(dir, { recursive: true });
  });

  it("lists operations, creates applications and exports reports", async () => {
    const { api: tracked } = await (await call("/api/apis", "POST", { url: api.url, intervalMinutes: 0 })).json();
    const ops = await (await call(`/api/apis/${tracked.id}/operations`)).json();
    expect(ops.map((o: { key: string }) => o.key)).toEqual(["GET /pets", "POST /pets", "DELETE /pets/{}", "GET /pets/{}"]);

    expect((await call("/api/apps", "POST", { name: "x", dependencies: [{ apiId: "nope", operations: "all" }] })).status).toBe(400);
    const created = await call("/api/apps", "POST", { name: "Shop", dependencies: [{ apiId: tracked.id, operations: ["GET /pets"] }] });
    expect(created.status).toBe(201);

    const csv = await call("/api/reports/breaking?format=csv&since=30");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await call("/api/channels", "POST", { name: "t", type: "teams", url: "not a url" })).status).toBe(400);
  });
});
