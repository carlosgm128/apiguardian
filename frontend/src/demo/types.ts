// Types for the demo dataset (written by backend/scripts/export-demo.ts). Type-only imports.
export type { ComparisonReport } from "../../../backend/src/orchestrator.js";
export type { Application, Channel, VersionRef } from "../../../backend/src/apps/types.js";
import type { ComparisonReport } from "../../../backend/src/orchestrator.js";
import type { Application, Channel } from "../../../backend/src/apps/types.js";
import type { Operation } from "../api";
import type { CheckRecord, RunEvent, RunMeta, Snapshot, TrackedApi } from "../types";

export type RecordingRole =
  | "petstore-ollama" | "petstore-gpu" | "petstore-simulate" | "petstore-diff"
  | "docs-ollama" | "docs-simulate" | "docs-diff"
  | "lead-failed" | "lead-rerun"
  | "tracker-1" | "tracker-2";

export interface RecordedRun {
  meta: RunMeta;
  events: RunEvent[];
  report: ComparisonReport;
  markdown: string;
}

export interface DemoRecording {
  recordedAt: string;
  runs: Record<RecordingRole, RecordedRun>;
  api: {
    api: TrackedApi;
    /** Oldest first; the last one is what "Check now" finds. */
    versions: Snapshot[];
    checks: CheckRecord[];
    snapshots: Record<string, unknown>;
    operations: Record<string, Operation[]>;
  };
  /** Requests the real formatter built for tracker-2's impacts, keyed "appId/channelId". */
  notifications: Record<string, { url: string; headers: Record<string, string>; body: string }>;
  runPlaceholder: string;
}

export interface DemoSeed {
  applications: Application[];
  channels: Channel[];
}
