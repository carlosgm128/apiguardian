import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentContext } from "../src/agents/backend.js";
import { createBackend, MixedBackend } from "../src/agents/factory.js";
import { ClaudeBackend } from "../src/agents/claude.js";
import { OllamaBackend } from "../src/agents/ollama.js";
import type { RiskReport, UnitAnalysis } from "../src/agents/schemas.js";
import type { AgentEvent } from "../src/events.js";
import type { DiffResult, WorkUnit } from "../src/types.js";

// A scripted stand-in for the Ollama REST API.

interface FakeModel {
  name: string;
  capabilities: string[];
}

type ChatReply = { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]; prompt_eval_count?: number; prompt_eval_cached_count?: number; done_reason?: string; status?: number; error?: string };

class FakeOllama {
  server!: Server;
  url!: string;
  requests: { path: string; body: any }[] = [];
  replies: ChatReply[] = [];
  constructor(public models: FakeModel[]) {}

  async start() {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      this.requests.push({ path: req.url!, body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/api/tags") return send(200, { models: this.models.map((m) => ({ ...m, details: { parameter_size: "4B" } })) });
      const model = this.models.find((m) => m.name === body?.model);
      if (!model) return send(404, { error: `model '${body?.model}' not found` });
      if (req.url === "/api/show") return send(200, { capabilities: model.capabilities });
      if (req.url === "/api/chat") {
        const reply = this.replies.shift() ?? { content: "{}" };
        if (reply.status) return send(reply.status, { error: reply.error });
        return send(200, {
          model: model.name,
          message: { role: "assistant", content: reply.content ?? "", tool_calls: reply.tool_calls },
          done_reason: reply.done_reason ?? "stop",
          prompt_eval_count: reply.prompt_eval_count ?? 100,
          prompt_eval_cached_count: reply.prompt_eval_cached_count ?? 0,
          eval_count: 20,
        });
      }
      send(404, { error: "unknown route" });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  chats() {
    return this.requests.filter((r) => r.path === "/api/chat").map((r) => r.body);
  }
}

const unit: WorkUnit = {
  id: "GET /pets",
  format: "openapi",
  title: "GET /pets",
  status: "modified",
  changes: [{ id: "GET /pets#1", unitId: "GET /pets", kind: "security-required", location: "GET /pets > security", severity: "breaking", message: "Authentication is now required" }],
};
const diff: DiffResult = { format: "openapi", units: [unit] };
const analysis: Omit<UnitAnalysis, "unitId"> = { summary: "Auth now required", findings: [], risks: [] };
const report: RiskReport = {
  overview: "Breaking: auth required",
  risks: [{ title: "Auth", severity: "critical", likelihood: "high", description: "d", failureScenario: "401", affectedUnits: ["GET /pets"], mitigation: "send key" }],
  crossCuttingNotes: [],
};

function context() {
  const events: AgentEvent[] = [];
  const ctx: AgentContext = { emit: (e) => events.push(e), signal: new AbortController().signal };
  return { ctx, events };
}

describe("OllamaBackend", () => {
  let fake: FakeOllama | undefined;
  afterEach(() => new Promise<void>((r) => (fake ? fake.server.close(() => r()) : r())));

  it("runs a worker with schema-constrained JSON and reports the call", async () => {
    fake = await new FakeOllama([{ name: "qwen:4b", capabilities: ["completion", "tools", "thinking"] }]).start();
    fake.replies.push({ content: JSON.stringify(analysis) });
    const { ctx, events } = context();
    const result = await new OllamaBackend({ baseUrl: fake.url, workerModel: "qwen:4b", numCtx: 8192 }).analyzeUnit(unit, ctx);

    expect(result).toEqual({ unitId: "GET /pets", ...analysis });
    const [chat] = fake.chats();
    expect(chat).toMatchObject({ model: "qwen:4b", stream: false, think: false, options: { num_ctx: 8192 } });
    expect(chat.format).toMatchObject({ type: "object", required: expect.arrayContaining(["summary", "findings", "risks"]) });
    expect(events[0]).toMatchObject({ type: "llm-call", provider: "ollama", role: "worker", unitId: "GET /pets", usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it("retries once when the JSON doesn't match the schema", async () => {
    fake = await new FakeOllama([{ name: "m", capabilities: ["completion"] }]).start();
    fake.replies.push({ content: '{"summary": 3}' }, { content: `<think>fixing</think>${JSON.stringify(analysis)}` });
    const { ctx } = context();
    const result = await new OllamaBackend({ baseUrl: fake.url, workerModel: "m" }).analyzeUnit(unit, ctx);
    expect(result.summary).toBe("Auth now required");
    const second = fake.chats()[1];
    expect(second.messages.at(-1).content).toMatch(/not valid JSON/);
    expect(second.think).toBeUndefined(); // model has no thinking capability
  });

  it("drives the lead's tool loop: investigate, rejected submit, valid submit", async () => {
    fake = await new FakeOllama([{ name: "lead", capabilities: ["completion", "tools"] }]).start();
    fake.replies.push(
      { tool_calls: [{ function: { name: "investigate", arguments: { unitId: "GET /pets", question: "Is a migration documented?" } } }] },
      { tool_calls: [{ function: { name: "submit_risk_report", arguments: { overview: "x" } } }] },
      { tool_calls: [{ function: { name: "submit_risk_report", arguments: report as unknown as Record<string, unknown> } }] },
    );
    const asked: string[] = [];
    const { ctx, events } = context();
    const result = await new OllamaBackend({ baseUrl: fake.url, leadModel: "lead" }).synthesize(
      { diff, analyses: [{ unitId: "GET /pets", ...analysis }], failedUnits: [] },
      async (unitId, question) => (asked.push(`${unitId}: ${question}`), { unitId, ...analysis }),
      ctx,
    );

    expect(result).toEqual(report);
    expect(asked).toEqual(["GET /pets: Is a migration documented?"]);
    const chats = fake.chats();
    expect(chats).toHaveLength(3);
    expect(chats[0].tools.map((t: any) => t.function.name)).toEqual(["investigate", "submit_risk_report"]);
    expect(chats[2].messages.at(-1)).toMatchObject({ role: "tool", tool_name: "submit_risk_report", content: expect.stringMatching(/does not match the schema/) });
    const calls = events.filter((e) => e.type === "llm-call");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({ prompt: { user: expect.stringContaining("[investigate result]") } });
    expect(events.filter((e) => e.type === "lead-tool-call").map((e) => e.type === "lead-tool-call" && e.tool)).toEqual(["investigate", "submit_risk_report", "submit_risk_report"]);
  });

  it("falls back to one structured answer when the lead model can't call tools", async () => {
    fake = await new FakeOllama([{ name: "coder", capabilities: ["completion"] }]).start();
    fake.replies.push({ content: JSON.stringify(report) });
    const { ctx, events } = context();
    const result = await new OllamaBackend({ baseUrl: fake.url, leadModel: "coder" }).synthesize({ diff, analyses: [], failedUnits: [] }, async () => { throw new Error("unused"); }, ctx);
    expect(result).toEqual(report);
    expect(fake.chats()[0].tools).toBeUndefined();
    expect(fake.chats()[0].format).toBeDefined();
    expect(events[0]).toMatchObject({ type: "lead-text", text: expect.stringContaining("does not support tool calling") });
  });

  it("picks installed models when none is configured, preferring tool support for the lead", async () => {
    fake = await new FakeOllama([
      { name: "embed", capabilities: ["embedding"] },
      { name: "plain", capabilities: ["completion"] },
      { name: "agentic", capabilities: ["completion", "tools"] },
    ]).start();
    fake.replies.push({ content: JSON.stringify(analysis) }, { content: "", tool_calls: [{ function: { name: "submit_risk_report", arguments: report as unknown as Record<string, unknown> } }] });
    const backend = new OllamaBackend({ baseUrl: fake.url });
    await backend.analyzeUnit(unit, context().ctx);
    await backend.synthesize({ diff, analyses: [], failedUnits: [] }, async () => ({ unitId: "x", ...analysis }), context().ctx);
    expect(fake.chats().map((c) => c.model)).toEqual(["plain", "agentic"]);
  });

  it("treats an unreachable server and missing models as fatal", async () => {
    const down = new OllamaBackend({ baseUrl: "http://127.0.0.1:1", workerModel: "m" });
    const err1 = await down.analyzeUnit(unit, context().ctx).catch((e) => e);
    expect(err1.message).toMatch(/Cannot reach Ollama/);
    expect(down.isFatal(err1)).toBe(true);

    fake = await new FakeOllama([{ name: "m", capabilities: ["completion"] }]).start();
    const missing = new OllamaBackend({ baseUrl: fake.url, workerModel: "nope:1b" });
    const err2 = await missing.analyzeUnit(unit, context().ctx).catch((e) => e);
    expect(err2.message).toMatch(/ollama pull nope:1b/);
    expect(missing.isFatal(err2)).toBe(true);
  });

  it("splits cached prompt tokens out of the total, like Claude's usage", async () => {
    fake = await new FakeOllama([{ name: "m", capabilities: ["completion"] }]).start();
    // Ollama's prompt_eval_count is the whole prompt; the cached count is a subset.
    fake.replies.push({ content: JSON.stringify(analysis), prompt_eval_count: 9000, prompt_eval_cached_count: 7000 });
    const { ctx, events } = context();
    await new OllamaBackend({ baseUrl: fake.url, workerModel: "m", numCtx: 10000 }).analyzeUnit(unit, ctx);
    expect(events[0]).toMatchObject({ usage: { inputTokens: 2000, cacheReadTokens: 7000 } });
  });

  it("accepts severity synonyms and casing from tool arguments", async () => {
    fake = await new FakeOllama([{ name: "lead", capabilities: ["completion", "tools"] }]).start();
    const loose = { ...report, risks: [{ ...report.risks[0]!, severity: "Info", likelihood: " High " }] };
    fake.replies.push({ tool_calls: [{ function: { name: "submit_risk_report", arguments: loose as unknown as Record<string, unknown> } }] });
    const result = await new OllamaBackend({ baseUrl: fake.url, leadModel: "lead" }).synthesize({ diff, analyses: [], failedUnits: [] }, async () => ({ unitId: "u", ...analysis }), context().ctx);
    expect(result.risks[0]).toMatchObject({ severity: "low", likelihood: "high" });
  });

  it("spreads workers over endpoints (least busy first) and pins the lead", async () => {
    const a = await new FakeOllama([{ name: "m", capabilities: ["completion", "tools"] }]).start();
    const b = await new FakeOllama([{ name: "m", capabilities: ["completion", "tools"] }]).start();
    try {
      // 4 concurrent workers over 2 endpoints: 2 replies each, then the lead's turn on gpu1.
      for (let i = 0; i < 2; i++) {
        a.replies.push({ content: JSON.stringify(analysis) });
        b.replies.push({ content: JSON.stringify(analysis) });
      }
      b.replies.push({ tool_calls: [{ function: { name: "submit_risk_report", arguments: report as unknown as Record<string, unknown> } }] });
      const gpu0 = { id: "gpu0", url: a.url, gpus: "0" };
      const gpu1 = { id: "gpu1", url: b.url, gpus: "1" };
      const backend = new OllamaBackend({ endpoints: [gpu0, gpu1], leadEndpoint: gpu1, workerModel: "m", leadModel: "m" });
      const { ctx, events } = context();

      await Promise.all([1, 2, 3, 4].map((n) => backend.analyzeUnit({ ...unit, id: `u${n}` }, ctx)));
      expect(a.chats()).toHaveLength(2);
      expect(b.chats()).toHaveLength(2);

      await backend.synthesize({ diff, analyses: [], failedUnits: [] }, async () => ({ unitId: "u", ...analysis }), ctx);
      expect(b.chats()).toHaveLength(3);
      expect(b.chats()[2].tools).toBeDefined();

      const calls = events.filter((e) => e.type === "llm-call");
      expect(calls.map((c) => c.type === "llm-call" && `${c.role}@${c.endpoint}`).sort()).toEqual(
        ["lead@gpu1", "worker@gpu0", "worker@gpu0", "worker@gpu1", "worker@gpu1"],
      );
    } finally {
      await new Promise<void>((r) => a.server.close(() => r()));
      await new Promise<void>((r) => b.server.close(() => r()));
    }
  });

  it("retries a tool call Ollama can't parse, then falls back to a structured report", async () => {
    fake = await new FakeOllama([{ name: "lead", capabilities: ["completion", "tools"] }]).start();
    const xmlError = "XML syntax error on line 12: element <parameter> closed by </function>";
    fake.replies.push({ status: 500, error: xmlError }, { status: 500, error: xmlError }, { content: JSON.stringify(report) });
    const { ctx, events } = context();
    const result = await new OllamaBackend({ baseUrl: fake.url, leadModel: "lead" }).synthesize({ diff, analyses: [], failedUnits: [] }, async () => ({ unitId: "u", ...analysis }), ctx);

    expect(result).toEqual(report);
    const chats = fake.chats();
    expect(chats.map((c) => (c.tools ? "tools" : c.format ? "structured" : "?"))).toEqual(["tools", "tools", "structured"]);
    // The failed calls are visible in the Inference view.
    const calls = events.filter((e) => e.type === "llm-call");
    expect(calls.map((c) => c.type === "llm-call" && c.stopReason)).toEqual(["error", "error", "stop"]);
    expect(calls[0]).toMatchObject({ output: expect.stringContaining("XML syntax error") });
  });

  it("fails instead of accepting a silently truncated prompt", async () => {
    fake = await new FakeOllama([{ name: "m", capabilities: ["completion"] }]).start();
    fake.replies.push({ content: JSON.stringify(analysis), prompt_eval_count: 2048 });
    const backend = new OllamaBackend({ baseUrl: fake.url, workerModel: "m", numCtx: 2048 });
    const err = await backend.analyzeUnit(unit, context().ctx).catch((e) => e);
    expect(err.message).toMatch(/filled the 2048-token context window/);
    expect(backend.isFatal(err)).toBe(false);
  });
});

describe("createBackend", () => {
  it("builds single-provider and mixed backends", () => {
    expect(createBackend({ mode: "diff" })).toBeUndefined();
    expect(createBackend({ mode: "ollama" })).toBeInstanceOf(OllamaBackend);
    expect(createBackend({ mode: "claude", leadProvider: "claude" })).toBeInstanceOf(ClaudeBackend);
    expect(createBackend({ mode: "ollama", leadProvider: "claude" })).toBeInstanceOf(MixedBackend);
  });

  it("routes workers and the lead to their own backends", async () => {
    const calls: string[] = [];
    const fake = (name: string) => ({
      analyzeUnit: async () => (calls.push(`${name}:worker`), { unitId: "u", ...analysis }),
      synthesize: async () => (calls.push(`${name}:lead`), report),
      isFatal: (e: unknown) => e === name,
    });
    const mixed = new MixedBackend(fake("ollama"), fake("claude"));
    await mixed.analyzeUnit(unit, context().ctx);
    await mixed.synthesize({ diff, analyses: [], failedUnits: [] }, async () => ({ unitId: "u", ...analysis }), context().ctx);
    expect(calls).toEqual(["ollama:worker", "claude:lead"]);
    expect(mixed.isFatal("claude")).toBe(true);
    expect(mixed.isFatal("other")).toBe(false);
  });
});
