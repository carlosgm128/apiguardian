import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, normalize } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ollamaEndpoints } from "../agents/factory.js";
import { endpointStatus } from "../compute/endpoints.js";
import { listGpus } from "../compute/gpus.js";
import type { RunEvent } from "../events.js";
import { discoverSpec, SpecFetchError } from "../history/spec.js";
import { UnknownApiError, type ApiTracker } from "../history/tracker.js";
import { NotFoundError, type AppService } from "../apps/service.js";
import { RetryError, type RunManager } from "./runs.js";
import { codeVersion as defaultCodeVersion } from "./version.js";

export interface DashboardServer {
  url: string;
  close(): Promise<void>;
}

export interface DashboardServerOptions {
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** Built React app; defaults to dist/web next to the compiled server. */
  webDir?: string;
  /** Enables the tracked-API routes (/api/apis). */
  tracker?: ApiTracker;
  /** Enables applications, notification channels and reports. */
  apps?: AppService;
  /** How to read the code version (tests inject one). */
  codeVersion?: () => Promise<string | undefined>;
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Agent settings for the automatic report a tracked API gets on each new version. */
const AgentsBody = z.object({
  mode: z.enum(["claude", "ollama", "simulate", "diff"]),
  leadProvider: z.enum(["claude", "ollama"]).optional(),
  concurrency: z.number().int().min(1).max(32).default(4),
  skipInfo: z.boolean().default(false),
  workerModel: z.string().optional(),
  leadModel: z.string().optional(),
  workerEffort: z.enum(EFFORTS).optional(),
  leadEffort: z.enum(EFFORTS).optional(),
  failureRate: z.number().min(0).max(1).optional(),
  workerEndpoints: z.array(z.string()).max(64).optional(),
  leadEndpoint: z.string().optional(),
});
const Headers = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name"), z.string().max(8192));
const NewApiBody = z.object({
  name: z.string().max(100).optional(),
  url: z.string().min(1).max(2048),
  headers: Headers.optional(),
  intervalMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
  agents: AgentsBody.partial().optional(),
});
const ApiPatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().min(1).max(2048).optional(),
  headers: Headers.optional(),
  intervalMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
  enabled: z.boolean().optional(),
  agents: AgentsBody.partial().optional(),
});
const CompareBody = z.object({ from: z.string(), to: z.string() });
const RetryBody = z.object({ scope: z.enum(["lead", "failed", "all"]), config: AgentsBody.partial().optional() });

const SeverityEnum = z.enum(["breaking", "warning", "info"]);
const DependencyBody = z.object({
  apiId: z.string().min(1),
  operations: z.union([z.literal("all"), z.array(z.string().max(500)).max(5000)]),
  note: z.string().max(500).optional(),
});
const AppBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  owner: z.string().max(200).optional(),
  contact: z.string().max(200).optional(),
  dependencies: z.array(DependencyBody).max(200).optional(),
  channelIds: z.array(z.string()).max(100).optional(),
  minSeverity: SeverityEnum.optional(),
});
const ChannelBody = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["slack", "teams", "discord", "webhook", "github", "gitlab"]),
  url: z.string().min(1).max(2048),
  secret: z.string().max(500).optional(),
  token: z.string().max(500).optional(),
  ref: z.string().max(200).optional(),
  eventType: z.string().max(100).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name"), z.string().max(8192)).optional(),
  enabled: z.boolean().optional(),
});

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

const FileInput = z.object({ name: z.string().min(1), content: z.string() });
const StartRunBody = z
  .object({
    sample: z.string().optional(),
    baseline: FileInput.optional(),
    candidate: FileInput.optional(),
    mode: z.enum(["claude", "ollama", "simulate", "diff"]),
    leadProvider: z.enum(["claude", "ollama"]).optional(),
    workerEndpoints: z.array(z.string()).max(64).optional(),
    leadEndpoint: z.string().optional(),
    concurrency: z.number().int().min(1).max(32).default(4),
    skipInfo: z.boolean().default(false),
    workerModel: z.string().optional(),
    leadModel: z.string().optional(),
    workerEffort: z.enum(EFFORTS).optional(),
    leadEffort: z.enum(EFFORTS).optional(),
    failureRate: z.number().min(0).max(1).optional(),
  })
  .refine((b) => b.sample || (b.baseline && b.candidate), "Provide a sample id or both baseline and candidate files");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Dashboard API + static React app. Bound to localhost; requests whose Host
 * or Origin isn't a loopback name are rejected so other websites can't
 * start runs (which spend LLM credits) through the browser.
 */
export async function startDashboardServer(manager: RunManager, options: DashboardServerOptions = {}): Promise<DashboardServer> {
  const webDir = options.webDir ?? findWebDir();
  const readVersion = options.codeVersion ?? (() => defaultCodeVersion());
  const startedAt = new Date().toISOString();
  const startVersion = await readVersion();
  const streams = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!isLoopback(req.headers.host) || (req.headers.origin && !isLoopback(req.headers.origin))) {
      throw new HttpError(403, "Only localhost requests are accepted");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (parts[0] !== "api") return serveStatic(res, webDir, url.pathname);

    // /api/version: is this server still running the code that's on disk?
    if (parts[1] === "version" && method === "GET") {
      const current = await readVersion();
      return sendJson(res, 200, { startedAt, version: startVersion ?? null, current: current ?? null, stale: Boolean(startVersion && current && current !== startVersion) });
    }

    // /api/status
    if (parts[1] === "status" && method === "GET") {
      const ollama = manager.ollamaSettings;
      const [endpoints, gpus] = await Promise.all([Promise.all(ollamaEndpoints(ollama).map(endpointStatus)), listGpus()]);
      return sendJson(res, 200, {
        credentials: hasCredentials(),
        samples: manager.samples().map(({ id, label }) => ({ id, label })),
        ollama: { endpoints, numCtx: ollama.numCtx ?? 16384, think: ollama.think ?? false },
        gpus,
      });
    }

    // /api/compute: live GPU usage and what each Ollama endpoint has loaded (System page).
    if (parts[1] === "compute" && method === "GET") {
      const [endpoints, gpus] = await Promise.all([Promise.all(ollamaEndpoints(manager.ollamaSettings).map(endpointStatus)), listGpus()]);
      return sendJson(res, 200, { gpus, endpoints });
    }

    if (parts[1] === "apis" && parts[3] === "operations" && method === "GET") {
      if (!options.apps) throw new HttpError(404, "Applications are not enabled on this server");
      try {
        return sendJson(res, 200, await options.apps.operations(parts[2]!));
      } catch (error) {
        throw error instanceof UnknownApiError ? new HttpError(404, error.message) : error;
      }
    }
    if (parts[1] === "apis") return handleApis(req, res, parts.slice(2), method);
    if (["apps", "channels", "deliveries", "reports"].includes(parts[1]!)) return handleApps(req, res, parts.slice(1), method, url);
    if (parts[1] !== "runs") throw new HttpError(404, "Not found");

    // /api/runs
    if (parts.length === 2) {
      if (method === "GET") return sendJson(res, 200, manager.list());
      if (method === "POST") {
        const parsed = StartRunBody.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
        const body = parsed.data;
        let baseline = body.baseline;
        let candidate = body.candidate;
        if (body.sample) {
          const sample = manager.samples().find((s) => s.id === body.sample);
          if (!sample) throw new HttpError(400, `Unknown sample "${body.sample}"`);
          baseline = { name: basename(sample.baseline), content: await readFile(sample.baseline, "utf8") };
          candidate = { name: basename(sample.candidate), content: await readFile(sample.candidate, "utf8") };
        }
        try {
          const meta = await manager.start({
            baseline: baseline!,
            candidate: candidate!,
            config: {
              mode: body.mode,
              leadProvider: body.leadProvider,
              workerEndpoints: body.workerEndpoints,
              leadEndpoint: body.leadEndpoint,
              concurrency: body.concurrency,
              skipInfo: body.skipInfo,
              workerModel: body.workerModel,
              leadModel: body.leadModel,
              workerEffort: body.workerEffort,
              leadEffort: body.leadEffort,
              failureRate: body.failureRate,
            },
          });
          return sendJson(res, 201, meta);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
      }
      throw new HttpError(405, "Method not allowed");
    }

    // /api/runs/:id[/...]
    const id = parts[2]!;
    const meta = manager.get(id);
    if (!meta) throw new HttpError(404, `No run ${id}`);
    const sub = parts[3];

    if (!sub && method === "GET") return sendJson(res, 200, meta);
    if (sub === "cancel" && method === "POST") {
      const cancelled = manager.cancel(id);
      return sendJson(res, cancelled ? 202 : 409, cancelled ? manager.get(id) : { error: "Run is not running", run: meta });
    }
    if (sub === "retry-info" && method === "GET") return sendJson(res, 200, await manager.retryInfo(id));
    if (sub === "retry" && method === "POST") {
      const body = parseBody(RetryBody, await readJson(req));
      try {
        return sendJson(res, 201, await manager.retry(id, body));
      } catch (error) {
        // Bad scope for this run, unknown endpoint ids, missing inputs: all fixable by the caller.
        throw new HttpError(error instanceof RetryError ? 409 : 400, error instanceof Error ? error.message : String(error));
      }
    }
    if (sub === "report" && method === "GET") {
      const report = await manager.report(id);
      if (!report) throw new HttpError(404, "Report not available yet");
      return sendJson(res, 200, report);
    }
    if (sub === "applications" && method === "GET") {
      const applications = options.apps ? await options.apps.applicationsForRun(id) : undefined;
      return sendJson(res, 200, { tracked: applications !== undefined, applications: applications ?? [] });
    }
    if (sub === "report.md" && method === "GET") {
      // Rendered on request so the summary lists applications added after the run.
      const md = (options.apps && (await options.apps.renderRunReport(id))) || (await manager.reportMarkdown(id));
      if (!md) throw new HttpError(404, "Report not available yet");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="apiguardian-${id}.md"`,
      });
      return void res.end(md);
    }
    if (sub === "events" && method === "GET") {
      const log = await manager.events(id);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (event: RunEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      for (const event of log!.events) send(event);
      const unsubscribe = log!.subscribe(send);
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      streams.add(res);
      req.on("close", () => {
        unsubscribe();
        clearInterval(heartbeat);
        streams.delete(res);
      });
      return;
    }
    throw new HttpError(404, "Not found");
  }

  // /api/apps, /api/channels, /api/deliveries, /api/reports: who uses which API, and who to tell.
  async function handleApps(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, url: URL) {
    const apps = options.apps;
    if (!apps) throw new HttpError(404, "Applications are not enabled on this server");
    try {
      const [kind, id, sub] = parts;
      if (kind === "apps") {
        if (!id && method === "GET") return sendJson(res, 200, apps.listApps());
        if (!id && method === "POST") return sendJson(res, 201, await apps.createApp(parseBody(AppBody, await readJson(req))));
        if (id && !sub && method === "GET") return sendJson(res, 200, apps.appDetail(id));
        if (id && !sub && method === "PATCH") return sendJson(res, 200, await apps.updateApp(id, parseBody(AppBody.partial(), await readJson(req))));
        if (id && !sub && method === "DELETE") {
          await apps.deleteApp(id);
          return sendJson(res, 200, { deleted: id });
        }
        if (id && sub === "backfill" && method === "POST") return sendJson(res, 200, { impacts: await apps.backfill(id) });
      }
      if (kind === "channels") {
        if (!id && method === "GET") return sendJson(res, 200, apps.listChannels());
        if (!id && method === "POST") return sendJson(res, 201, await apps.createChannel(parseBody(ChannelBody, await readJson(req))));
        if (id && !sub && method === "PATCH") return sendJson(res, 200, await apps.updateChannel(id, parseBody(ChannelBody.partial(), await readJson(req))));
        if (id && !sub && method === "DELETE") {
          await apps.deleteChannel(id);
          return sendJson(res, 200, { deleted: id });
        }
        if (id && sub === "test" && method === "POST") return sendJson(res, 200, await apps.testChannel(id));
      }
      if (kind === "deliveries" && method === "GET") return sendJson(res, 200, await apps.deliveries());
      if (kind === "reports" && id === "breaking" && method === "GET") {
        const q = url.searchParams;
        const filter = {
          sinceDays: q.get("since") ? Number(q.get("since")) : undefined,
          appId: q.get("app") || undefined,
          apiId: q.get("api") || undefined,
          minSeverity: (SeverityEnum.safeParse(q.get("min")).data ?? undefined) as "breaking" | "warning" | "info" | undefined,
        };
        const format = q.get("format");
        if (format === "md" || format === "csv") {
          const body = format === "md" ? apps.reportMarkdown(filter) : apps.reportCsv(filter);
          res.writeHead(200, {
            "content-type": format === "md" ? "text/markdown; charset=utf-8" : "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="breaking-changes.${format}"`,
          });
          return void res.end(body);
        }
        return sendJson(res, 200, apps.impactsFor(filter));
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof NotFoundError) throw new HttpError(404, error.message);
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  // /api/apis/... : tracked APIs and their version history.
  async function handleApis(req: IncomingMessage, res: ServerResponse, parts: string[], method: string) {
    const tracker = options.tracker;
    if (!tracker) throw new HttpError(404, "API tracking is not enabled on this server");
    // Spec fetch problems are the user's input, not server faults.
    const userError = (error: unknown) => {
      if (error instanceof HttpError) return error;
      if (error instanceof UnknownApiError) return new HttpError(404, error.message);
      if (error instanceof SpecFetchError) return new HttpError(422, error.message);
      return new HttpError(400, error instanceof Error ? error.message : String(error));
    };
    try {
      const [id, sub, extra] = parts;
      if (!id) {
        if (method === "GET") return sendJson(res, 200, tracker.list());
        if (method === "POST") return sendJson(res, 201, await tracker.add(parseBody(NewApiBody, await readJson(req)) as Parameters<ApiTracker["add"]>[0]));
        throw new HttpError(405, "Method not allowed");
      }
      if (id === "discover" && method === "POST") {
        const body = parseBody(z.object({ url: z.string().min(1), headers: Headers.optional() }), await readJson(req));
        const found = await discoverSpec(body.url, body.headers);
        return sendJson(res, 200, { url: found.url, summary: found.summary, hash: found.hash });
      }
      if (!sub) {
        if (method === "GET") return sendJson(res, 200, await tracker.detail(id));
        if (method === "PATCH") return sendJson(res, 200, await tracker.update(id, parseBody(ApiPatchBody, await readJson(req)) as Parameters<ApiTracker["update"]>[1]));
        if (method === "DELETE") {
          await tracker.remove(id);
          return sendJson(res, 200, { deleted: id });
        }
        throw new HttpError(405, "Method not allowed");
      }
      if (sub === "check" && method === "POST") return sendJson(res, 200, await tracker.check(id, "manual"));
      if (sub === "compare" && method === "POST") {
        const body = parseBody(CompareBody, await readJson(req));
        return sendJson(res, 201, await tracker.compare(id, body.from, body.to));
      }
      if (sub === "snapshots" && extra && method === "GET") {
        const content = await tracker.snapshotContent(id, extra);
        if (content === undefined) throw new HttpError(404, "No such snapshot");
        res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${id}-${extra}.json"` });
        return void res.end(content);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      throw userError(error);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4319, options.host ?? "127.0.0.1", resolve);
  });
  const { address, port } = server.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;

  return {
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.end();
        server.close(() => resolve());
      }),
  };
}

function isLoopback(hostOrOrigin: string | undefined): boolean {
  if (!hostOrOrigin) return false;
  try {
    const { hostname } = new URL(hostOrOrigin.includes("://") ? hostOrOrigin : `http://${hostOrOrigin}`);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Env credentials or an `ant auth login` profile. The SDK resolves both. */
function hasCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || existsSync(join(homedir(), ".config", "anthropic")),
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function serveStatic(res: ServerResponse, webDir: string | undefined, pathname: string) {
  if (!webDir) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    return void res.end("The dashboard is not built. Run `npm run build:web`, or `npm run dev:web` for development.");
  }
  // The app uses hash routing, so anything that isn't a file gets index.html.
  const file = normalize(join(webDir, pathname));
  const target = file.startsWith(webDir) && extname(file) && existsSync(file) ? file : join(webDir, "index.html");
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": target.includes(`${join("assets", "")}`) ? "public, max-age=31536000, immutable" : "no-store",
  });
  res.end(await readFile(target));
}

function findWebDir(): string | undefined {
  // dist/server -> dist/web when built; backend/src/server -> dist/web when run via tsx.
  const candidates = ["../web", "../../../dist/web"].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}
