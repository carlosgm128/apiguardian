import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ollamaEndpoints, selectEndpoints } from "../src/agents/factory.js";
import { parseEndpointFlag, startManagedOllama, type ManagedOllama } from "../src/compute/endpoints.js";
import { listGpus, parseNvidiaSmi } from "../src/compute/gpus.js";

describe("GPU inventory", () => {
  it("parses nvidia-smi CSV, including [N/A] fields", () => {
    const csv = [
      "0, GPU-aaa, NVIDIA GeForce RTX 4090, 24564, 1200, 37, 45",
      "1, GPU-bbb, NVIDIA A100-SXM4-40GB, 40960, 39000, [N/A], [N/A]",
      "",
    ].join("\n");
    expect(parseNvidiaSmi(csv)).toEqual([
      { index: 0, uuid: "GPU-aaa", name: "NVIDIA GeForce RTX 4090", memoryTotalMb: 24564, memoryUsedMb: 1200, utilizationPct: 37, temperatureC: 45 },
      { index: 1, uuid: "GPU-bbb", name: "NVIDIA A100-SXM4-40GB", memoryTotalMb: 40960, memoryUsedMb: 39000, utilizationPct: null, temperatureC: null },
    ]);
  });

  it("reports missing nvidia-smi instead of throwing", async () => {
    expect(await listGpus("definitely-not-nvidia-smi")).toEqual({ available: false, gpus: [], error: "definitely-not-nvidia-smi not found" });
  });
});

describe("endpoint configuration", () => {
  it("parses id=url[@gpu]", () => {
    expect(parseEndpointFlag("gpu1=http://127.0.0.1:11435@1")).toEqual({ id: "gpu1", url: "http://127.0.0.1:11435", gpus: "1" });
    expect(parseEndpointFlag("big=10.0.0.5:11434@0,1")).toEqual({ id: "big", url: "http://10.0.0.5:11434", gpus: "0,1" });
    expect(parseEndpointFlag("cpu=http://localhost:11434/")).toEqual({ id: "cpu", url: "http://localhost:11434" });
    expect(() => parseEndpointFlag("http://x")).toThrow(/id=url/);
    expect(() => parseEndpointFlag("bad id=http://x")).toThrow(/may only contain/);
  });

  it("selects worker and lead endpoints by id", () => {
    const settings = { endpoints: [{ id: "gpu0", url: "http://a" }, { id: "gpu1", url: "http://b" }] };
    expect(selectEndpoints({}, settings)).toEqual({ workers: settings.endpoints, lead: settings.endpoints[0] });
    expect(selectEndpoints({ workerEndpoints: ["gpu1"], leadEndpoint: "gpu0" }, settings)).toEqual({ workers: [settings.endpoints[1]], lead: settings.endpoints[0] });
    expect(() => selectEndpoints({ leadEndpoint: "gpu7" }, settings)).toThrow(/Unknown Ollama endpoint "gpu7" \(configured: gpu0, gpu1\)/);
    expect(ollamaEndpoints({ baseUrl: "http://h:1/" })).toEqual([{ id: "default", url: "http://h:1" }]);
  });
});

describe("managed per-GPU Ollama instances", () => {
  let dir: string;
  let managed: ManagedOllama | undefined;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "apiguardian-ollama-"))));
  afterEach(async () => {
    await managed?.stop();
    managed = undefined;
    await rm(dir, { recursive: true });
  });

  // Stands in for `ollama serve`: listens on OLLAMA_HOST and reports which GPU it was given.
  const fakeOllama = `
    import { createServer } from "node:http";
    const [host, port] = process.env.OLLAMA_HOST.split(":");
    createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "fake", gpu: process.env.CUDA_VISIBLE_DEVICES, rocr: process.env.ROCR_VISIBLE_DEVICES }));
    }).listen(Number(port), host);
  `;

  it("starts one instance per GPU with only that GPU visible, and stops them", async () => {
    const script = join(dir, "fake-ollama.mjs");
    await writeFile(script, fakeOllama);
    managed = await startManagedOllama({ gpus: ["0", "1"], basePort: 21500 + Math.floor(Math.random() * 500), command: process.execPath, args: [script] });

    expect(managed.endpoints.map(({ id, gpus, managed: m }) => ({ id, gpus, m }))).toEqual([
      { id: "gpu0", gpus: "0", m: true },
      { id: "gpu1", gpus: "1", m: true },
    ]);
    const seen = await Promise.all(managed.endpoints.map(async (ep) => (await fetch(`${ep.url}/api/version`)).json()));
    expect(seen).toEqual([
      { version: "fake", gpu: "0", rocr: "0" },
      { version: "fake", gpu: "1", rocr: "1" },
    ]);

    const urls = managed.endpoints.map((e) => e.url);
    await managed.stop();
    managed = undefined;
    for (const url of urls) await expect(fetch(`${url}/api/version`)).rejects.toThrow();
  });

  it("fails at startup when an instance can't read its model store, and cleans up", async () => {
    const script = join(dir, "no-store.mjs");
    await writeFile(script, `
      import { createServer } from "node:http";
      const [host, port] = process.env.OLLAMA_HOST.split(":");
      createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/tags") { res.statusCode = 500; return res.end(JSON.stringify({ error: "mkdir " + process.env.OLLAMA_MODELS + ": permission denied" })); }
        res.end(JSON.stringify({ version: "fake" }));
      }).listen(Number(port), host);
    `);
    const port = 22500 + Math.floor(Math.random() * 400);
    const err = await startManagedOllama({ gpus: ["0"], basePort: port, command: process.execPath, args: [script], modelsDir: "/srv/models" }).catch((e) => e);
    expect(err.message).toMatch(/can't read its model store: mkdir \/srv\/models: permission denied.*--ollama-models/);
    await expect(fetch(`http://127.0.0.1:${port}/api/version`)).rejects.toThrow();
  });

  it("reports an instance that exits during startup", async () => {
    const script = join(dir, "crash.mjs");
    await writeFile(script, `console.error("Error: listen tcp: address already in use"); process.exit(1);`);
    await expect(startManagedOllama({ gpus: ["0"], basePort: 22000, command: process.execPath, args: [script] })).rejects.toThrow(/exited with 1: Error: listen tcp: address already in use/);
  });
});
