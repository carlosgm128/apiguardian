import type { LlmUsage } from "../types.js";

// USD per million tokens, from Anthropic's published API pricing (Sep 2026).
// Estimates only: check the Console for actual billing. Cache writes are
// billed at 1.25x input (5-minute TTL).
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export const MODEL_OPTIONS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

/** Zero for local Ollama models; null when the model has no known price (including the simulated backend). */
export function estimateCost(model: string, usage: LlmUsage, provider?: string): number | null {
  if (provider === "ollama") return 0;
  const price = PRICES[model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.input * 1.25) /
    1e6
  );
}

/** Sums costs; null if any part is unknown and nothing is known. */
export function sumCosts(costs: (number | null)[]): number | null {
  const known = costs.filter((c): c is number => c !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
