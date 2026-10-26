import { useState, type MouseEvent, type ReactNode } from "react";
import { secs, tok } from "../lib/format";
import { unitStatus, type RunState, type UnitState } from "../state/runState";
import { SevCounts, StatusBadge } from "./ui";

// Gantt of worker attempts and the lead agent. Status colors are paired with
// a second channel: failed bars are hatched, follow-up attempts are outlined,
// and every row carries a status icon + label.

interface Props {
  state: RunState;
  now: number;
  selected: string | null;
  onSelect: (id: string) => void;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function niceStep(totalMs: number): number {
  const steps = [500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  return steps.find((s) => totalMs / s <= 8) ?? 1_200_000;
}

export function Timeline({ state, now, selected, onSelect }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  if (!state.start || state.t0 === null) return null;
  const t0 = state.t0;
  const end = state.end?.t ?? now;
  const span = Math.max(1000, end - t0);
  const left = (t: number) => `${((t - t0) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, b - a) / span) * 100}%`;
  const step = niceStep(span);
  const ticks: number[] = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);

  const showTip = (e: MouseEvent, content: ReactNode) => {
    const box = (e.currentTarget.closest(".timeline") as HTMLElement).getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, content });
  };

  const order: Record<string, number> = { running: 0, failed: 1, done: 2, queued: 3, "not-run": 4, skipped: 5, "diff-only": 6 };
  const rows = [...state.units.values()].sort((a, b) => {
    const sa = a.attempts[0]?.start ?? Infinity;
    const sb = b.attempts[0]?.start ?? Infinity;
    return sa - sb || order[unitStatus(state, a)]! - order[unitStatus(state, b)]! || a.unit.id.localeCompare(b.unit.id);
  });
  const lead = state.lead;
  const leadStart = lead.start;

  return (
    <div className="timeline" onMouseLeave={() => setTip(null)}>
      <div className="tl-legend">
        <span><i className="sw sw-running" />running</span>
        <span><i className="sw sw-done" />done</span>
        <span><i className="sw sw-failed" />failed (hatched)</span>
        <span><i className="sw sw-followup" />follow-up from lead (outlined)</span>
        {[...state.units.values()].some((u) => u.attempts.some((a) => a.reusedFrom)) && <span><i className="sw sw-reused" />reused from earlier run (dashed)</span>}
        <span><i className="sw sw-lead" />lead agent</span>
        <span><i className="sw-mark" />lead tool call</span>
      </div>
      <div className="tl-scroll">
        <div className="tl-grid">
          <div className="tl-axis">
            <span />
            <div className="tl-ticks">
              {ticks.map((t) => (
                <span key={t} style={{ left: `${(t / span) * 100}%` }}>{secs(t)}</span>
              ))}
            </div>
          </div>

          {state.start.agents && (
            <div className={`tl-row tl-lead${selected === null ? " selected" : ""}`} onClick={() => onSelect("")}>
              <div className="tl-label">
                <StatusBadge status={lead.status === "idle" && state.end ? "not-run" : lead.status} label="Lead agent" />
              </div>
              <div className="tl-track">
                {ticks.map((t) => <span key={t} className="tl-gridline" style={{ left: `${(t / span) * 100}%` }} />)}
                {leadStart !== null && (
                  <div
                    className={`bar bar-lead${lead.status === "running" ? " is-running" : ""}${lead.status === "failed" ? " is-failed" : ""}`}
                    style={{ left: left(leadStart), width: width(leadStart, lead.end ?? end) }}
                    onMouseMove={(e) => showTip(e, <><b>Lead agent</b><div>{lead.status} · {secs((lead.end ?? end) - leadStart)}</div><div>{lead.calls.length} LLM turns</div></>)}
                  />
                )}
                {lead.items.map((it, i) =>
                  it.kind === "tool" ? (
                    <div
                      key={i}
                      className={`tl-mark${it.event.tool === "submit_risk_report" ? " submit" : ""}`}
                      style={{ left: left(it.event.t) }}
                      onMouseMove={(e) => showTip(e, <><b>{it.event.tool}</b><pre>{JSON.stringify(it.event.input, null, 2)}</pre></>)}
                    />
                  ) : null,
                )}
              </div>
            </div>
          )}

          {rows.map((u) => (
            <UnitRow key={u.unit.id} u={u} state={state} end={end} left={left} width={width} ticks={ticks} span={span}
              selected={selected === u.unit.id} onSelect={onSelect} showTip={showTip} />
          ))}
        </div>
      </div>
      {tip && (
        <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          {tip.content}
        </div>
      )}
    </div>
  );
}

function UnitRow({ u, state, end, left, width, ticks, span, selected, onSelect, showTip }: {
  u: UnitState;
  state: RunState;
  end: number;
  left: (t: number) => string;
  width: (a: number, b: number) => string;
  ticks: number[];
  span: number;
  selected: boolean;
  onSelect: (id: string) => void;
  showTip: (e: MouseEvent, content: ReactNode) => void;
}) {
  const status = unitStatus(state, u);
  return (
    <div className={`tl-row${selected ? " selected" : ""}`} onClick={() => onSelect(u.unit.id)}>
      <div className="tl-label" title={u.unit.title}>
        <StatusBadge status={status} label="" />
        <span className="tl-name">{u.unit.title}</span>
        <SevCounts changes={u.unit.changes} />
      </div>
      <div className="tl-track">
        {ticks.map((t) => <span key={t} className="tl-gridline" style={{ left: `${(t / span) * 100}%` }} />)}
        {u.attempts.map((a, i) => {
          const stop = a.end ?? end;
          const call = u.calls.find((c) => c.t >= a.start && c.t <= stop + 5);
          return (
            <div
              key={i}
              className={`bar${a.question ? " is-followup" : ""}${a.reusedFrom ? " is-reused" : ""} is-${a.status}`}
              style={{ left: left(a.start), width: width(a.start, stop) }}
              onMouseMove={(e) =>
                showTip(e, (
                  <>
                    <b>{u.unit.title}</b>
                    <div>{a.reusedFrom ? `Analysis reused from run ${a.reusedFrom}` : <>{a.question ? "Follow-up from lead" : "Worker"} · {a.status} · {secs(stop - a.start)}</>}</div>
                    {a.question && <div className="tip-q">{a.question}</div>}
                    {call && <div>{call.model}{call.endpoint ? ` on ${call.endpoint}` : ""} · {tok(call.usage.inputTokens)} in / {tok(call.usage.outputTokens)} out</div>}
                    {a.error && <div className="tip-err">{a.error}</div>}
                  </>
                ))
              }
            />
          );
        })}
      </div>
    </div>
  );
}
