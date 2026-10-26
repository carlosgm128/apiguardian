import { useEffect, useState } from "react";
import { api } from "../api";
import { navigate } from "../hooks/hooks";
import type { RunState } from "../state/runState";
import type { Severity } from "../types";
import { Panel, SevChip } from "./ui";

interface AppSummary {
  id?: string;
  name: string;
  owner?: string;
  unitIds: string[];
  counts: Record<Severity, number>;
}

const RANK: Record<Severity, number> = { breaking: 0, warning: 1, info: 2 };
const COLLAPSED_ROWS = 8;

/** Short version of the report: every changed endpoint and the applications it affects. */
export function RunSummary({ runId, state, onSelectUnit }: { runId: string; state: RunState; onSelectUnit: (unitId: string) => void }) {
  const [apps, setApps] = useState<{ tracked: boolean; applications: AppSummary[] } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const finished = Boolean(state.end);

  // Applications are matched once the run's report exists.
  useEffect(() => {
    if (!finished) return;
    fetch(`/api/runs/${encodeURIComponent(runId)}/applications`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setApps, () => setApps(null));
  }, [runId, finished]);

  if (!state.start) return null;
  const units = [...state.units.values()]
    .map((u) => {
      const c = { breaking: 0, warning: 0, info: 0 };
      for (const ch of u.unit.changes) c[ch.severity]++;
      const worst: Severity = c.breaking ? "breaking" : c.warning ? "warning" : "info";
      return { u, c, worst };
    })
    .sort((a, b) => RANK[a.worst] - RANK[b.worst] || b.c.breaking - a.c.breaking || a.u.unit.title.localeCompare(b.u.unit.title));
  if (units.length === 0) return null;

  const noun = state.start.format === "markdown" ? "section" : "endpoint";
  const usersByUnit = new Map<string, AppSummary[]>();
  for (const app of apps?.applications ?? []) for (const id of app.unitIds) usersByUnit.set(id, [...(usersByUnit.get(id) ?? []), app]);
  const total = units.reduce((t, { c }) => ({ breaking: t.breaking + c.breaking, warning: t.warning + c.warning, info: t.info + c.info }), { breaking: 0, warning: 0, info: 0 });
  const shown = expanded ? units : units.slice(0, COLLAPSED_ROWS);
  const showApps = apps?.tracked;
  const appLink = (a: AppSummary) =>
    a.id ? <button key={a.name} className="pill pill-link" onClick={() => navigate("apps", a.id!)}>{a.name}</button> : <span key={a.name} className="pill">{a.name}</span>;

  return (
    <Panel
      title="Summary"
      actions={
        <span className="muted small">
          {total.breaking} breaking · {total.warning} warning · {total.info} info in {units.length} {noun}{units.length === 1 ? "" : "s"}
          {showApps ? ` · ${apps!.applications.length} application${apps!.applications.length === 1 ? "" : "s"} affected` : ""}
        </span>
      }
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{noun === "section" ? "Section" : "Endpoint"}</th>
              <th>Change</th>
              <th>Severity</th>
              {showApps && <th>Applications affected</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ u, c }) => (
              <tr key={u.unit.id} className="clickable" onClick={() => onSelectUnit(u.unit.id)}>
                <td className="mono wrap">{u.unit.title}</td>
                <td>{u.unit.status}</td>
                <td>
                  <span className="sev-counts">
                    {c.breaking > 0 && <SevChip severity="breaking">{c.breaking}</SevChip>}
                    {c.warning > 0 && <SevChip severity="warning">{c.warning}</SevChip>}
                    {c.info > 0 && <SevChip severity="info">{c.info}</SevChip>}
                  </span>
                </td>
                {showApps && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <span className="app-chips">{usersByUnit.get(u.unit.id)?.map(appLink) ?? <span className="muted">–</span>}</span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {units.length > COLLAPSED_ROWS && (
        <div className="pad-x">
          <button className="btn-link" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show all ${units.length} ${noun}s`}</button>
        </div>
      )}
      <div className="pad summary-apps">
        {!finished && <span className="muted small">Affected applications appear when the run finishes.</span>}
        {finished && apps && !apps.tracked && (
          <span className="muted small">Applications are matched only for tracked APIs (the APIs page); this comparison isn't from one.</span>
        )}
        {finished && showApps && apps!.applications.length === 0 && <span className="muted small">No registered application uses the changed parts of this API.</span>}
        {finished && showApps && apps!.applications.length > 0 && (
          <>
            <strong className="small">Applications affected</strong>
            <ul className="app-impacts">
              {[...apps!.applications]
                .sort((a, b) => b.counts.breaking - a.counts.breaking || b.counts.warning - a.counts.warning)
                .map((a) => (
                  <li key={a.name}>
                    {appLink(a)}
                    {a.owner && <span className="muted small">{a.owner}</span>}
                    <span className="sev-counts">
                      {a.counts.breaking > 0 && <SevChip severity="breaking">{a.counts.breaking} breaking</SevChip>}
                      {a.counts.warning > 0 && <SevChip severity="warning">{a.counts.warning} warning</SevChip>}
                    </span>
                    <span className="muted small">uses {a.unitIds.length} changed {noun}{a.unitIds.length === 1 ? "" : "s"}</span>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}
