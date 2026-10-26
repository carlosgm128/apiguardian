import { useState } from "react";
import { api, type ReportFilter } from "../api";
import { ImpactList } from "../components/Impacts";
import { Panel, StatTiles } from "../components/ui";
import { usePoll } from "../hooks/hooks";
import type { Severity } from "../types";

const PERIODS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
];

export function ReportsPage() {
  const [filter, setFilter] = useState<ReportFilter>({ since: 30, min: "breaking" });
  const effective: ReportFilter = { ...filter, since: filter.since || undefined };
  const { data: impacts, error } = usePoll(() => api.breakingReport(effective), 15_000, [JSON.stringify(effective)]);
  const { data: apps } = usePoll(api.applications, 0);
  const { data: trackedApis } = usePoll(api.apis, 0);
  const set = (patch: Partial<ReportFilter>) => setFilter({ ...filter, ...patch });

  const list = impacts ?? [];
  const affectedApps = new Set(list.map((i) => i.appId)).size;
  const breaking = list.reduce((n, i) => n + i.counts.breaking, 0);
  const warnings = list.reduce((n, i) => n + i.counts.warning, 0);
  const apisChanged = new Set(list.map((i) => i.apiId)).size;

  return (
    <div className="stack-lg">
      <Panel
        title="Breaking changes report"
        actions={
          <span className="row-actions">
            <a className="btn" href={api.breakingReportUrl(effective, "md")}>Export Markdown</a>
            <a className="btn" href={api.breakingReportUrl(effective, "csv")}>Export CSV</a>
          </span>
        }
      >
        <div className="pad toolbar">
          <select aria-label="Period" value={filter.since ?? 0} onChange={(e) => set({ since: Number(e.target.value) })}>
            {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
          </select>
          <select aria-label="Application" value={filter.app ?? ""} onChange={(e) => set({ app: e.target.value || undefined })}>
            <option value="">All applications</option>
            {apps?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select aria-label="API" value={filter.api ?? ""} onChange={(e) => set({ api: e.target.value || undefined })}>
            <option value="">All APIs</option>
            {trackedApis?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select aria-label="Severity" value={filter.min ?? "info"} onChange={(e) => set({ min: e.target.value as Severity })}>
            <option value="breaking">Breaking only</option>
            <option value="warning">Breaking and warnings</option>
            <option value="info">Everything</option>
          </select>
        </div>
        <div className="pad">
          <StatTiles
            tiles={[
              { label: "Applications affected", value: affectedApps, sub: apps ? `of ${apps.length}` : "" },
              { label: "Impacts", value: list.length },
              { label: "Breaking changes", value: breaking },
              { label: "Warnings", value: warnings },
              { label: "APIs that changed", value: apisChanged },
            ]}
          />
        </div>
        {error && <p className="error pad">{error}</p>}
        <ImpactList impacts={list} showApp empty="No application was affected by API changes in this scope." />
        <p className="hint pad">
          An impact is one API version change as it affects one application: only the operations that application uses, plus spec-wide
          changes such as servers or authentication. Click a row for the full list of changes and risks.
        </p>
      </Panel>
    </div>
  );
}
