import type { AgentBackend, AgentContext, Investigate, SynthesisInput } from "./backend.js";
import { ClaudeBackend, type Effort } from "./claude.js";
import type { OllamaEndpoint } from "../compute/endpoints.js";
import { OllamaBackend, defaultOllamaUrl } from "./ollama.js";
import type { RiskReport, UnitAnalysis } from "./schemas.js";
import { SimulatedBackend } from "./simulated.js";
import type { WorkUnit } from "../types.js";

export type Provider = "claude" | "ollama";

export interface AgentConfig {
  mode: "claude" | "ollama" | "simulate" | "diff";
  /** Provider for the lead agent; defaults to the worker provider (`mode`). */
  leadProvider?: Provider;
  workerModel?: string;
  leadModel?: string;
  /** Claude only. */
  workerEffort?: Effort;
  leadEffort?: Effort;
  /** Simulated mode only. */
  failureRate?: number;
  /** Ollama endpoint ids the workers may use (spread least-busy first). Default: all. */
  workerEndpoints?: string[];
  /** Ollama endpoint id for the lead. Default: the first worker endpoint. */
  leadEndpoint?: string;
}

/** Server-side Ollama settings; never taken from API requests (runs pick endpoints by id). */
export interface OllamaSettings {
  /** Single-endpoint shorthand, used when `endpoints` is empty. */
  baseUrl?: string;
  /** Ollama instances, e.g. one per GPU. */
  endpoints?: OllamaEndpoint[];
  numCtx?: number;
  think?: boolean;
}

/** The configured endpoints, or one "default" endpoint at baseUrl / $OLLAMA_HOST. */
export function ollamaEndpoints(settings: OllamaSettings = {}): OllamaEndpoint[] {
  if (settings.endpoints?.length) return settings.endpoints;
  return [{ id: "default", url: (settings.baseUrl ?? defaultOllamaUrl()).replace(/\/+$/, "") }];
}

/** Resolves a run's endpoint ids against the server's endpoints; throws on unknown ids. */
export function selectEndpoints(config: Pick<AgentConfig, "workerEndpoints" | "leadEndpoint">, settings: OllamaSettings = {}) {
  const all = ollamaEndpoints(settings);
  const byId = (id: string) => {
    const ep = all.find((e) => e.id === id);
    if (!ep) throw new Error(`Unknown Ollama endpoint "${id}" (configured: ${all.map((e) => e.id).join(", ")})`);
    return ep;
  };
  const workers = config.workerEndpoints?.length ? config.workerEndpoints.map(byId) : all;
  const lead = config.leadEndpoint ? byId(config.leadEndpoint) : workers[0]!;
  return { workers, lead };
}

/**
 * Builds the backend for a run. Workers use `mode`'s provider; the lead uses
 * `leadProvider` (default: the same), so e.g. local Ollama workers can report
 * to a Claude lead.
 */
export function createBackend(config: AgentConfig, ollama: OllamaSettings = {}): AgentBackend | undefined {
  if (config.mode === "diff") return undefined;
  if (config.mode === "simulate") return new SimulatedBackend({ failureRate: config.failureRate });

  const workerProvider: Provider = config.mode;
  const leadProvider = config.leadProvider ?? workerProvider;
  const placement = workerProvider === "ollama" || leadProvider === "ollama" ? selectEndpoints(config, ollama) : undefined;
  const make = (provider: Provider, models: { workerModel?: string; leadModel?: string }) =>
    provider === "claude"
      ? new ClaudeBackend({ ...models, workerEffort: config.workerEffort, leadEffort: config.leadEffort })
      : new OllamaBackend({ numCtx: ollama.numCtx, think: ollama.think, endpoints: placement!.workers, leadEndpoint: placement!.lead, ...models });

  if (workerProvider === leadProvider) return make(workerProvider, { workerModel: config.workerModel, leadModel: config.leadModel });
  return new MixedBackend(make(workerProvider, { workerModel: config.workerModel }), make(leadProvider, { leadModel: config.leadModel }));
}

/** Workers from one backend, lead from another. Follow-up investigations still go to the workers' backend. */
export class MixedBackend implements AgentBackend {
  constructor(
    private readonly workers: AgentBackend,
    private readonly lead: AgentBackend,
  ) {}

  analyzeUnit(unit: WorkUnit, ctx: AgentContext & { question?: string }): Promise<UnitAnalysis> {
    return this.workers.analyzeUnit(unit, ctx);
  }

  synthesize(input: SynthesisInput, investigate: Investigate, ctx: AgentContext): Promise<RiskReport> {
    return this.lead.synthesize(input, investigate, ctx);
  }

  isFatal(error: unknown): boolean {
    return Boolean(this.workers.isFatal?.(error) || this.lead.isFatal?.(error));
  }
}

export function describeAgents(config: AgentConfig): string {
  const names = { claude: "Claude", ollama: "Ollama", simulate: "Simulated", diff: "Diff only" } as const;
  const lead = config.leadProvider;
  if ((config.mode === "claude" || config.mode === "ollama") && lead && lead !== config.mode) {
    return `${names[config.mode]} workers, ${names[lead]} lead`;
  }
  return names[config.mode];
}
