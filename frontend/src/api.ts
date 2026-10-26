import type { Application, Channel, CheckRecord, Delivery, Dependency, EndpointStatus, GpuReport, ImpactRecord, RunConfig, RunMeta, Severity, Snapshot, SpecSummary, TrackedApi } from "./types";

export interface OllamaStatus {
  /** One per Ollama instance; several when agents are pinned to GPUs. */
  endpoints: EndpointStatus[];
  numCtx: number;
  think: boolean;
}

export interface ComputeStatus {
  gpus: GpuReport;
  endpoints: EndpointStatus[];
}

export interface ServerStatus {
  credentials: boolean;
  samples: { id: string; label: string }[];
  ollama: OllamaStatus;
  gpus: GpuReport;
}

export interface StartRunRequest {
  sample?: string;
  baseline?: { name: string; content: string };
  candidate?: { name: string; content: string };
  mode: "claude" | "ollama" | "simulate" | "diff";
  leadProvider?: "claude" | "ollama";
  workerEndpoints?: string[];
  leadEndpoint?: string;
  concurrency: number;
  skipInfo: boolean;
  workerModel?: string;
  leadModel?: string;
  workerEffort?: string;
  leadEffort?: string;
  failureRate?: number;
}

export type ApiListItem = TrackedApi & { versions: number; latest?: Snapshot };
export interface ApiDetail {
  api: TrackedApi;
  /** Newest first. */
  versions: Snapshot[];
  checks: CheckRecord[];
}
export interface NewApiRequest {
  name?: string;
  url: string;
  headers?: Record<string, string>;
  intervalMinutes?: number;
  agents?: Partial<RunConfig>;
}

export type AppListItem = Application & { impacts: number; breaking30d: number; lastImpact?: ImpactRecord };
export interface AppInput {
  name?: string;
  description?: string;
  owner?: string;
  contact?: string;
  dependencies?: Dependency[];
  channelIds?: string[];
  minSeverity?: Severity;
}
export type ChannelInput = Partial<Omit<Channel, "id" | "createdAt">>;
export interface ReportFilter {
  since?: number;
  app?: string;
  api?: string;
  min?: Severity;
}
export interface Operation {
  key: string;
  method: string;
  path: string;
  summary?: string;
  deprecated: boolean;
}

const query = (f: ReportFilter) =>
  new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

export interface RetryInfo {
  retryable: boolean;
  analyses: number;
  failedUnits: number;
  notRunUnits: number;
  units: number;
  leadError?: string;
  hasRiskReport: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  status: () => call<ServerStatus>("/api/status"),
  version: () => call<{ startedAt: string; version: string | null; current: string | null; stale: boolean }>("/api/version"),
  compute: () => call<ComputeStatus>("/api/compute"),
  runs: () => call<RunMeta[]>("/api/runs"),
  run: (id: string) => call<RunMeta>(`/api/runs/${encodeURIComponent(id)}`),
  start: (req: StartRunRequest) => call<RunMeta>("/api/runs", { method: "POST", body: JSON.stringify(req) }),
  cancel: (id: string) => call<RunMeta>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  eventsUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/events`,
  retryInfo: (id: string) => call<RetryInfo>(`/api/runs/${encodeURIComponent(id)}/retry-info`),
  retry: (id: string, body: { scope: "lead" | "failed" | "all"; config?: Partial<RunConfig> }) =>
    call<RunMeta>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify(body) }),
  reportMdUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/report.md`,
  apis: () => call<ApiListItem[]>("/api/apis"),
  api: (id: string) => call<ApiDetail>(`/api/apis/${encodeURIComponent(id)}`),
  addApi: (req: NewApiRequest) => call<ApiDetail>("/api/apis", { method: "POST", body: JSON.stringify(req) }),
  updateApi: (id: string, patch: Partial<NewApiRequest> & { enabled?: boolean }) =>
    call<ApiDetail>(`/api/apis/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteApi: (id: string) => call<{ deleted: string }>(`/api/apis/${encodeURIComponent(id)}`, { method: "DELETE" }),
  checkApi: (id: string) => call<CheckRecord>(`/api/apis/${encodeURIComponent(id)}/check`, { method: "POST", body: "{}" }),
  compareApi: (id: string, from: string, to: string) =>
    call<RunMeta>(`/api/apis/${encodeURIComponent(id)}/compare`, { method: "POST", body: JSON.stringify({ from, to }) }),
  discover: (url: string, headers?: Record<string, string>) =>
    call<{ url: string; summary: SpecSummary; hash: string }>("/api/apis/discover", { method: "POST", body: JSON.stringify({ url, headers }) }),
  operations: (apiId: string) => call<Operation[]>(`/api/apis/${encodeURIComponent(apiId)}/operations`),
  applications: () => call<AppListItem[]>("/api/apps"),
  application: (id: string) => call<{ app: Application; impacts: ImpactRecord[] }>(`/api/apps/${encodeURIComponent(id)}`),
  createApplication: (input: AppInput) => call<{ app: Application; impacts: ImpactRecord[] }>("/api/apps", { method: "POST", body: JSON.stringify(input) }),
  updateApplication: (id: string, input: AppInput) =>
    call<{ app: Application; impacts: ImpactRecord[] }>(`/api/apps/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteApplication: (id: string) => call<{ deleted: string }>(`/api/apps/${encodeURIComponent(id)}`, { method: "DELETE" }),
  channels: () => call<Channel[]>("/api/channels"),
  createChannel: (input: ChannelInput) => call<Channel>("/api/channels", { method: "POST", body: JSON.stringify(input) }),
  updateChannel: (id: string, input: ChannelInput) => call<Channel>(`/api/channels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteChannel: (id: string) => call<{ deleted: string }>(`/api/channels/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testChannel: (id: string) => call<Delivery>(`/api/channels/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" }),
  deliveries: () => call<Delivery[]>("/api/deliveries"),
  breakingReport: (f: ReportFilter) => call<ImpactRecord[]>(`/api/reports/breaking?${query(f)}`),
  breakingReportUrl: (f: ReportFilter, format: "md" | "csv") => `/api/reports/breaking?${query({ ...f })}&format=${format}`,
  snapshotUrl: (id: string, snapshotId: string) => `/api/apis/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`,
};
