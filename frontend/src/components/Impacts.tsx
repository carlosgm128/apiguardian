import { Fragment, useState } from "react";
import { navigate } from "../hooks/hooks";
import type { ImpactRecord } from "../types";
import { Empty, SevChip } from "./ui";

/** Impact records, newest first; each expands to the changes that touch the application. */
export function ImpactList({ impacts, showApp = false, empty }: { impacts: ImpactRecord[]; showApp?: boolean; empty: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (impacts.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            {showApp && <th>Application</th>}
            <th>API</th>
            <th>Versions</th>
            <th>Impact</th>
            <th>Most important change</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {impacts.map((i) => {
            const top = i.changes[0];
            const expanded = open === i.id;
            return (
              <Fragment key={i.id}>
                <tr className="clickable" onClick={() => setOpen(expanded ? null : i.id)} aria-expanded={expanded}>
                  <td title={i.at}>{new Date(i.at).toLocaleDateString()}</td>
                  {showApp && <td className="strong">{i.appName}</td>}
                  <td>{i.apiName}</td>
                  <td className="mono">v{i.from.version ?? "?"} → v{i.to.version ?? "?"}</td>
                  <td>
                    <span className="sev-counts">
                      {i.counts.breaking > 0 && <SevChip severity="breaking">{i.counts.breaking} breaking</SevChip>}
                      {i.counts.warning > 0 && <SevChip severity="warning">{i.counts.warning} warning</SevChip>}
                      {i.counts.breaking === 0 && i.counts.warning === 0 && <SevChip severity="info">{i.counts.info} info</SevChip>}
                    </span>
                  </td>
                  <td className="wrap">{top ? <><span className="mono small">{top.location}</span> <span className="muted">{top.message}</span></> : <span className="muted">{i.risks[0]?.title}</span>}</td>
                  <td>
                    <button className="btn-link" onClick={(e) => (e.stopPropagation(), navigate("runs", i.runId))}>Report</button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="detail-row">
                    <td colSpan={showApp ? 7 : 6}>
                      <ul className="cards">
                        {i.changes.map((c) => (
                          <li key={c.id}>
                            <div className="card-title"><SevChip severity={c.severity} /> <span>{c.message}</span></div>
                            <div className="mono muted">{c.location}</div>
                          </li>
                        ))}
                        {i.risks.map((r, n) => (
                          <li key={`risk-${n}`}>
                            <div className="card-title"><SevChip severity={r.severity} /> <strong>{r.title}</strong></div>
                            <div className="muted">{r.failureScenario}</div>
                            <div className="muted">Mitigation: {r.mitigation}</div>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
