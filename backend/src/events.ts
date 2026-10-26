import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { RiskReport, UnitAnalysis } from "./agents/schemas.js";
import type { DocFormat, WorkUnit } from "./types.js";

// Everything a run does is described by these events. The CLI logs them,
// the UI renders them, and events.jsonl stores them for replay.

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Emitted by an AgentBackend while it works. */
export type AgentEvent =
  | {
      type: "llm-call";
      role: "worker" | "lead";
      unitId?: string;
      /** Which backend served the call; Ollama calls are local and cost nothing. */
      provider?: "claude" | "ollama" | "simulated";
      /** Ollama endpoint id (one per GPU when pinned), for local calls. */
      endpoint?: string;
      model: string;
      /** Time spent in the API call itself (tool execution excluded). */
      durationMs: number;
      usage: LlmUsage;
      stopReason: string | null;
      /** What the model was sent this turn (for the lead after turn 1: the tool results). */
      prompt?: { system?: string; user: string };
      /** What the model returned: parsed JSON for workers, text and tool calls for the lead. */
      output?: string;
    }
  | { type: "lead-tool-call"; tool: string; input: unknown }
  | { type: "lead-text"; text: string };

export type RunEventBody =
  | {
      type: "run-start";
      format: DocFormat;
      baselinePath: string;
      candidatePath: string;
      baselineVersion?: string;
      candidateVersion?: string;
      units: WorkUnit[];
      agents: boolean;
      simulated: boolean;
      concurrency: number;
    }
  | { type: "unit-skipped"; unitId: string; reason: "info-only" | "stopped" | "not-rerun" }
  /** Retry: the analysis of this unit was taken from an earlier run instead of calling a worker. */
  | { type: "unit-reused"; unitId: string; analysis: UnitAnalysis; fromRun: string }
  | { type: "unit-start"; unitId: string; question?: string }
  | { type: "unit-done"; unitId: string; question?: string; durationMs: number; analysis: UnitAnalysis }
  | { type: "unit-failed"; unitId: string; question?: string; durationMs: number; error: string }
  | { type: "synthesis-start" }
  | { type: "synthesis-done"; durationMs: number; riskReport: RiskReport }
  | { type: "synthesis-failed"; durationMs: number; error: string }
  | {
      type: "run-end";
      durationMs: number;
      failedUnits: number;
      /** Set when the run was stopped early: cancelled by the user or a fatal agent error. */
      stopped?: "cancelled" | "fatal";
      error?: string;
    }
  | AgentEvent;

/** `seq` orders events within a run; `t` is epoch milliseconds. */
export type RunEvent = RunEventBody & { seq: number; t: number };

type Listener = (event: RunEvent) => void;

/** In-memory event history with live subscribers and an optional JSONL file. */
export class EventLog {
  readonly events: RunEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private file?: WriteStream;

  /** Append every recorded event to `path` as one JSON object per line. */
  writeTo(path: string): this {
    this.file = createWriteStream(path, { flags: "w" });
    for (const e of this.events) this.file.write(`${JSON.stringify(e)}\n`);
    return this;
  }

  record(event: RunEvent): void {
    this.events.push(event);
    this.file?.write(`${JSON.stringify(event)}\n`);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    const file = this.file;
    this.file = undefined;
    if (file) await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }

  static async load(path: string): Promise<EventLog> {
    const log = new EventLog();
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) if (line.trim()) log.events.push(JSON.parse(line));
    return log;
  }
}
