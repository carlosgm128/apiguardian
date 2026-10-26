import type { Severity } from "../types.js";

// Applications consume tracked APIs. When a tracked API gets a new version,
// each application that depends on it gets an impact record (the changes and
// risks touching the operations it uses), and its notification channels hear
// about it if the impact is severe enough.

export interface Dependency {
  /** A tracked API id (see history/tracker.ts). */
  apiId: string;
  /** "all", or operation keys like "GET /pets/{}" (path parameter names erased, as in unit ids). */
  operations: "all" | string[];
  note?: string;
}

export interface Application {
  id: string;
  name: string;
  description?: string;
  /** Owning team or person. */
  owner?: string;
  /** Who to talk to, free text (email, Slack handle). */
  contact?: string;
  dependencies: Dependency[];
  channelIds: string[];
  /** Notify only for impacts at least this severe. */
  minSeverity: Severity;
  createdAt: string;
}

export type ChannelType = "slack" | "teams" | "discord" | "webhook" | "github" | "gitlab";

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  url: string;
  secret?: string;
  token?: string;
  ref?: string;
  eventType?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
}

export interface ImpactChange {
  id: string;
  unitId: string;
  severity: Severity;
  location: string;
  message: string;
}

export interface ImpactRisk {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  failureScenario: string;
  mitigation: string;
}

export interface VersionRef {
  id: string;
  seq: number;
  version?: string;
}

/** What one API change means for one application. */
export interface ImpactRecord {
  id: string;
  at: string;
  runId: string;
  appId: string;
  appName: string;
  apiId: string;
  apiName: string;
  from: VersionRef;
  to: VersionRef;
  counts: Record<Severity, number>;
  worst: Severity | null;
  changes: ImpactChange[];
  risks: ImpactRisk[];
}

export interface Delivery {
  id: string;
  at: string;
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  test: boolean;
  appId?: string;
  impactId?: string;
  ok: boolean;
  status?: number;
  attempts: number;
  durationMs: number;
  error?: string;
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 1, warning: 2, breaking: 3 };
