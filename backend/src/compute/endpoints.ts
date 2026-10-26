import { spawn, type ChildProcess } from "node:child_process";

// Ollama endpoints = where Ollama agents can run. One `ollama serve` decides
// GPU placement on its own, so pinning agents to GPUs means one instance per
// GPU (CUDA_VISIBLE_DEVICES / ROCR_VISIBLE_DEVICES), each on its own port.
// Endpoints are server-side configuration; API requests only pick them by id.

export interface OllamaEndpoint {
  id: string;
  url: string;
  /** GPU indices this instance can see (CUDA_VISIBLE_DEVICES), when known. */
  gpus?: string;
  /** Started and stopped by apiguardian (`--ollama-gpus`). */
  managed?: boolean;
}

const ID = /^[A-Za-z0-9_.-]{1,40}$/;

/** `gpu1=http://127.0.0.1:11435` or `gpu1=http://host:port@1` (with the GPU index it serves). */
export function parseEndpointFlag(value: string): OllamaEndpoint {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new Error(`--ollama-endpoint must look like id=url, got "${value}"`);
  const id = value.slice(0, eq).trim();
  let url = value.slice(eq + 1).trim();
  if (!ID.test(id)) throw new Error(`Endpoint id "${id}" may only contain letters, digits, ".", "_" and "-"`);
  let gpus: string | undefined;
  const at = url.lastIndexOf("@");
  if (at > url.indexOf("://") + 2 && /^[\d,]+$/.test(url.slice(at + 1))) {
    gpus = url.slice(at + 1);
    url = url.slice(0, at);
  }
  if (!url.includes("://")) url = `http://${url}`;
  new URL(url); // throws on garbage
  return { id, url: url.replace(/\/+$/, ""), ...(gpus && { gpus }) };
}

export interface ManagedOllama {
  endpoints: OllamaEndpoint[];
  stop(): Promise<void>;
}

export interface ManagedOllamaOptions {
  /** GPU indices, one instance each. */
  gpus: string[];
  basePort?: number;
  host?: string;
  command?: string;
  args?: string[];
  /** How long to wait for each instance to answer /api/version. */
  readyTimeoutMs?: number;
  /**
   * Model store for the instances (OLLAMA_MODELS). Needed when the usual
   * store isn't readable by this user, e.g. a systemd install keeps models
   * under /usr/share/ollama, owned by the `ollama` user.
   */
  modelsDir?: string;
}

/** Starts one `ollama serve` per GPU and waits until all respond. */
export async function startManagedOllama(options: ManagedOllamaOptions): Promise<ManagedOllama> {
  const { gpus, basePort = 11500, host = "127.0.0.1", command = "ollama", args = ["serve"], readyTimeoutMs = 30_000, modelsDir } = options;
  const children: ChildProcess[] = [];
  const stop = async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5000).unref();
          }),
      ),
    );
  };

  try {
    const endpoints = await Promise.all(
      gpus.map(async (gpu, i) => {
        const port = basePort + i;
        const url = `http://${host}:${port}`;
        const child = spawn(command, args, {
          env: {
            ...process.env,
            OLLAMA_HOST: `${host}:${port}`,
            // NVIDIA, and AMD/ROCm equivalents; each instance only sees its GPU.
            CUDA_VISIBLE_DEVICES: gpu,
            ROCR_VISIBLE_DEVICES: gpu,
            HIP_VISIBLE_DEVICES: gpu,
            ...(modelsDir && { OLLAMA_MODELS: modelsDir }),
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
        await waitReady(url, child, readyTimeoutMs, () => stderr);
        await checkModelStore(url);
        return { id: `gpu${gpu}`, url, gpus: gpu, managed: true } satisfies OllamaEndpoint;
      }),
    );
    return { endpoints, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitReady(url: string, child: ChildProcess, timeoutMs: number, stderr: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: string | undefined;
  child.once("exit", (code, signal) => (exited = `exited with ${signal ?? code}`));
  child.once("error", (e) => (exited = e.message));
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Ollama for ${url} ${exited}: ${stderr().trim().split("\n").slice(-3).join(" | ")}`);
    try {
      const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Ollama for ${url} did not start within ${timeoutMs / 1000}s`);
}

/**
 * An instance can start fine yet be unable to read its model store (it runs
 * as this user; a systemd install's store belongs to the `ollama` user).
 * Fail at startup with the fix, not later with an endpoint that has no models.
 */
async function checkModelStore(url: string): Promise<void> {
  const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (res.ok) return;
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(
    `Ollama at ${url} can't read its model store: ${error ?? res.status}. ` +
      "Point it at a readable store with --ollama-models <dir> (sets OLLAMA_MODELS), or run one Ollama per GPU as the " +
      "service user yourself (CUDA_VISIBLE_DEVICES=N OLLAMA_HOST=127.0.0.1:PORT ollama serve) and register each with --ollama-endpoint id=url@N.",
  );
}

export interface LoadedModel {
  name: string;
  sizeMb: number;
  vramMb: number;
  expiresAt?: string;
}

export interface EndpointStatus extends OllamaEndpoint {
  reachable: boolean;
  version?: string;
  models: { name: string; size?: string; tools: boolean }[];
  loaded: LoadedModel[];
}

/** Reachability, installed models and models currently in memory (/api/ps). */
export async function endpointStatus(endpoint: OllamaEndpoint): Promise<EndpointStatus> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${endpoint.url}${path}`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  try {
    type Tag = { name: string; capabilities?: string[]; details?: { parameter_size?: string } };
    type Ps = { name: string; size?: number; size_vram?: number; expires_at?: string };
    const [version, tags, ps] = await Promise.all([
      get<{ version: string }>("/api/version"),
      get<{ models: Tag[] }>("/api/tags"),
      get<{ models: Ps[] }>("/api/ps"),
    ]);
    return {
      ...endpoint,
      reachable: true,
      version: version.version,
      models: tags.models
        .filter((m) => !m.capabilities || m.capabilities.includes("completion"))
        .map((m) => ({ name: m.name, size: m.details?.parameter_size, tools: Boolean(m.capabilities?.includes("tools")) })),
      loaded: ps.models.map((m) => ({
        name: m.name,
        sizeMb: Math.round((m.size ?? 0) / 1048576),
        vramMb: Math.round((m.size_vram ?? 0) / 1048576),
        expiresAt: m.expires_at,
      })),
    };
  } catch {
    return { ...endpoint, reachable: false, models: [], loaded: [] };
  }
}
