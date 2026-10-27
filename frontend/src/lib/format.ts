export const secs = (ms: number): string =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export const tok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

export const usd = (n: number | null): string =>
  n === null ? "–" : n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(n < 10 ? 2 : 0)}`;

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** "in 12m", or "now" once the time has passed. */
export function until(iso: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}

export const fmtValue = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

const AGENT_NAMES = { claude: "Claude", ollama: "Ollama", simulate: "Simulated", diff: "Diff only" } as const;

/** e.g. "Ollama", or "Ollama workers, Claude lead" for mixed runs. */
export function agentsLabel(config: { mode: keyof typeof AGENT_NAMES; leadProvider?: "claude" | "ollama" }): string {
  const lead = config.leadProvider;
  if ((config.mode === "claude" || config.mode === "ollama") && lead && lead !== config.mode) {
    return `${AGENT_NAMES[config.mode]} workers, ${AGENT_NAMES[lead]} lead`;
  }
  return AGENT_NAMES[config.mode];
}
