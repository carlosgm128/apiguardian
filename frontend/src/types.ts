// Types shared with the server. Type-only imports: nothing from src/ is bundled.
export type { RunEvent, LlmUsage } from "../../backend/src/events.js";
export type { RunMeta, RunStatus, RunMode, RunSummary, RunConfig } from "../../backend/src/server/runs.js";
export type { RiskReport, UnitAnalysis } from "../../backend/src/agents/schemas.js";
export type { Change, Severity, WorkUnit } from "../../backend/src/types.js";
export type { EndpointStatus, LoadedModel } from "../../backend/src/compute/endpoints.js";
export type { GpuInfo, GpuReport } from "../../backend/src/compute/gpus.js";
export type { CheckRecord, Snapshot, TrackedApi } from "../../backend/src/history/tracker.js";
export type { SpecSummary } from "../../backend/src/history/spec.js";
export type { Application, Channel, ChannelType, Delivery, Dependency, ImpactRecord } from "../../backend/src/apps/types.js";

import type { RunEvent } from "../../backend/src/events.js";

export type EventOf<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;
export type LlmCall = EventOf<"llm-call">;
