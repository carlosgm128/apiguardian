import { useState } from "react";
import { api } from "../api";
import { intervalLabel } from "../components/ApiForms";
import { Empty, Panel, StatTiles } from "../components/ui";
import { navigate, useNow, usePoll } from "../hooks/hooks";
import { ago, secs, until } from "../lib/format";
import type { MonitoringApi, MonitoringReport } from "../types";
import { OutcomeBadge } from "./ApiDetailPage";

const WINDOWS = [1, 7, 30, 90];
const PAGE = 50;
/** Spec fetches usually take milliseconds. */
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : secs(ms));
type Filter = "all" | "changes" | "errors";

/** Where an API stands in the schedule, as a label and whether it needs attention. */
function scheduleState(a: MonitoringApi, report: MonitoringReport, now: number): { text: string; warn?: boolean } {
  if (!a.enabled) return { text: "Paused" };
  if (a.intervalMinutes <= 0 || !a.nextCheckAt) return { text: "On demand" };
  if (!report.scheduler.running) return { text: "Scheduler off", warn: true };
  // A due check normally starts within one scheduler tick; two missed ticks means something is stuck.
  const late = now - Date.parse(a.nextCheckAt);
  if (late > 2 * (report.scheduler.tickMs ?? 30_000)) return { text: `Overdue ${ago(a.nextCheckAt, now).replace(" ago", "")}`, warn: true };
  return { text: until(a.nextCheckAt, now) };
}

/** Checks per day, stacked by outcome. Unchanged checks are the recessive gray; failures are also hatched. */
function DailyChart({ daily }: { daily: MonitoringReport["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = daily.map((d) => d.baseline + d.unchanged + d.changed + d.error);
  const max = Math.max(1, ...totals);
  const labelEvery = Math.ceil(daily.length / 10);
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="mon-chart">
      <div className="tl-legend">
        <span><i className="sw sw-unchanged" />unchanged</span>
        <span><i className="sw sw-running" />new version</span>
        <span><i className="sw sw-failed" />failed (hatched)</span>
      </div>
      <div className="mon-plot" onMouseLeave={() => setHover(null)}>
        {daily.map((d, i) => {
          const changed = d.changed + d.baseline;
          const label = `${day(d.day)}: ${totals[i]} check${totals[i] === 1 ? "" : "s"}, ${changed} new version${changed === 1 ? "" : "s"}, ${d.error} failed`;
          return (
            <div key={d.day} className={`mon-col${hover === i ? " hover" : ""}`} tabIndex={0} aria-label={label} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              <div className="mon-stack" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                {d.error > 0 && <div className="mon-seg seg-error" style={{ flexGrow: d.error }} />}
                {changed > 0 && <div className="mon-seg seg-changed" style={{ flexGrow: changed }} />}
                {d.unchanged > 0 && <div className="mon-seg seg-unchanged" style={{ flexGrow: d.unchanged }} />}
              </div>
              {hover === i && (
                <div className={`mon-tip${i > daily.length / 2 ? " left" : ""}`} role="tooltip">
                  <div className="strong">{day(d.day)}</div>
                  <div>{totals[i]} checks</div>
                  <div>{d.unchanged} unchanged</div>
                  <div>{changed} new version{changed === 1 ? "" : "s"}</div>
                  <div>{d.error} failed</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mon-axis">
        {daily.map((d, i) => <span key={d.day}>{i % labelEvery === 0 || i === daily.length - 1 ? day(d.day) : ""}</span>)}
      </div>
      <div className="muted small pad-x">Busiest day: {max === 1 && totals.every((t) => t === 0) ? "no checks yet" : `${Math.max(...totals)} checks`}</div>
    </div>
  );
}

export function MonitoringPage() {
  const [days, setDays] = useState(7);
  const [filter, setFilter] = useState<Filter>("all");
  const [apiFilter, setApiFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const { data, error } = usePoll(() => api.monitoring(days), 10_000, [days]);
  const now = useNow(true, 1000);

  if (error && !data) return <Panel title="Monitoring"><Empty>{error}</Empty></Panel>;
  if (!data) return <Panel title="Monitoring"><Empty>Loading…</Empty></Panel>;

  const enabled = data.apis.filter((a) => a.enabled);
  const sum = (k: "checks" | "changed" | "error" | "baseline") => data.apis.reduce((n, a) => n + a.stats[k], 0);
  const checks = sum("checks");
  const errors = sum("error");
  const upcoming = data.apis.filter((a) => a.enabled && a.intervalMinutes > 0 && a.nextCheckAt).sort((a, b) => a.nextCheckAt!.localeCompare(b.nextCheckAt!));
  const next = upcoming[0];
  const schedule = [...upcoming, ...data.apis.filter((a) => !upcoming.includes(a))];
  const rows = data.checks.filter(
    (c) => (!apiFilter || c.apiId === apiFilter) && (filter === "all" || (filter === "errors" ? c.outcome === "error" : c.outcome === "changed" || c.outcome === "baseline")),
  );

  return (
    <div className="stack-lg">
      <header className="run-head">
        <div className="run-title"><h1>Monitoring</h1></div>
        <div className="run-meta">
          {data.scheduler.running ? (
            <span className="pill">Scheduler on · every {secs(data.scheduler.tickMs ?? 30_000)}</span>
          ) : (
            <span className="pill pill-warn">Scheduler off: only manual checks run</span>
          )}
          <span className="spacer" />
          <label className="small">
            Window{" "}
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {WINDOWS.map((d) => <option key={d} value={d}>{d === 1 ? "Today" : `Last ${d} days`}</option>)}
            </select>
          </label>
          <span className="muted small">refreshes every 10s</span>
        </div>
      </header>

      {data.apis.length === 0 ? (
        <Panel title="Tracked APIs">
          <Empty>
            No tracked APIs yet. <button className="btn-link" onClick={() => navigate("apis")}>Track an API</button> and its scheduled checks show up here, or{" "}
            <button className="btn-link" onClick={() => navigate("new")}>compare two documents</button> now.
          </Empty>
        </Panel>
      ) : (
        <>
          <StatTiles
            tiles={[
              { label: "Tracked APIs", value: data.apis.length, sub: enabled.length === data.apis.length ? "all active" : `${data.apis.length - enabled.length} paused` },
              { label: "Checks", value: checks, sub: days === 1 ? "today" : `${days} days` },
              { label: "New versions", value: sum("changed"), sub: sum("baseline") ? `+${sum("baseline")} first` : "" },
              { label: "Failed checks", value: errors, sub: checks ? `${Math.round((errors / checks) * 100)}%` : "" },
              { label: "Next check", value: next ? until(next.nextCheckAt!, now) : "–", sub: next?.name ?? "nothing scheduled" },
            ]}
          />

          <Panel title="Checks per day" actions={<span className="muted small">{data.totalChecks} in window · UTC days</span>}>
            <DailyChart daily={data.daily} />
          </Panel>

          <Panel title="Schedule">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Last result</th><th>API</th><th>Interval</th><th>Last check</th><th>Next check</th><th className="num">Versions</th><th>Last change</th><th className="num">Checks</th><th className="num">Failed</th><th className="num">Avg time</th></tr>
                </thead>
                <tbody>
                  {schedule.map((a) => {
                    const state = scheduleState(a, data, now);
                    return (
                      <tr key={a.id} className="clickable" onClick={() => navigate("apis", a.id)}>
                        <td>{a.lastOutcome ? <OutcomeBadge outcome={a.lastOutcome} /> : <span className="muted">never</span>}</td>
                        <td>
                          <div className="strong">{a.name}</div>
                          {a.lastOutcome === "error" && a.lastError && <div className="error small">{a.lastError}</div>}
                        </td>
                        <td>{intervalLabel(a.intervalMinutes)}</td>
                        <td>{a.lastCheckedAt ? ago(a.lastCheckedAt, now) : "–"}</td>
                        <td>{state.warn ? <span className="pill pill-warn">{state.text}</span> : state.text}</td>
                        <td className="num">{a.versions}</td>
                        <td>{a.lastChangeAt ? ago(a.lastChangeAt, now) : "–"}</td>
                        <td className="num">{a.stats.checks}</td>
                        <td className="num">{a.stats.error}</td>
                        <td className="num">{a.stats.avgDurationMs !== undefined ? duration(a.stats.avgDurationMs) : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Check log"
            actions={
              <span className="row-actions">
                <select value={apiFilter} onChange={(e) => { setApiFilter(e.target.value); setShown(PAGE); }} aria-label="API">
                  <option value="">All APIs</option>
                  {data.apis.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setShown(PAGE); }} aria-label="Outcome">
                  <option value="all">All checks</option>
                  <option value="changes">New versions</option>
                  <option value="errors">Failures</option>
                </select>
              </span>
            }
          >
            {rows.length === 0 ? (
              <Empty>No checks match.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>When</th><th>API</th><th>Result</th><th>Trigger</th><th className="num">Time</th><th className="num">HTTP</th><th>Details</th></tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, shown).map((c) => (
                      <tr key={`${c.apiId}-${c.at}`}>
                        <td title={new Date(c.at).toLocaleString()}>{ago(c.at, now)}</td>
                        <td><button className="btn-link" onClick={() => navigate("apis", c.apiId)}>{c.apiName}</button></td>
                        <td><OutcomeBadge outcome={c.outcome} /></td>
                        <td className="muted">{c.trigger}</td>
                        <td className="num">{duration(c.durationMs)}</td>
                        <td className="num mono">{c.status ?? "–"}</td>
                        <td>
                          {c.runId && <button className="btn-link" onClick={() => navigate("runs", c.runId!)}>Open report</button>}
                          {c.error && <div className="error small">{c.error}</div>}
                          {!c.runId && !c.error && c.snapshotId && <span className="mono muted small">{c.snapshotId}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > shown && (
              <p className="pad"><button className="btn" onClick={() => setShown((n) => n + PAGE)}>Show more ({rows.length - shown} left)</button></p>
            )}
            {data.totalChecks > data.checks.length && <p className="hint pad">Showing the newest {data.checks.length} of {data.totalChecks} checks in this window.</p>}
          </Panel>
        </>
      )}
    </div>
  );
}
