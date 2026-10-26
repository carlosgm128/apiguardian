import { useMemo, useState } from "react";
import { fmtValue, secs, tok, usd } from "../lib/format";
import { sumCosts } from "../lib/pricing";
import { callCost, latestAnalysis, unitStatus, type RunState } from "../state/runState";
import type { LlmCall, RunEvent, Severity } from "../types";
import { Empty, SevChip, SevCounts, StatusBadge } from "./ui";

// ---- Workers ---------------------------------------------------------------

export function WorkersView({ state, onSelect }: { state: RunState; onSelect: (unitId: string) => void }) {
  const rows = [...state.units.values()].map((u) => {
    const tokensIn = u.calls.reduce((n, c) => n + c.usage.inputTokens, 0);
    const tokensOut = u.calls.reduce((n, c) => n + c.usage.outputTokens, 0);
    const workMs = u.attempts.reduce((n, a) => n + (a.end !== null ? a.end - a.start : 0), 0);
    const analysis = latestAnalysis(u);
    return { u, status: unitStatus(state, u), tokensIn, tokensOut, workMs, cost: sumCosts(u.calls.map(callCost)), analysis };
  });
  if (rows.length === 0) return <Empty>No changed units.</Empty>;
  const anyCalls = rows.some((r) => r.u.calls.length > 0);

  return (
    <div className="stack">
      {anyCalls && <TokenBars rows={rows.map((r) => ({ id: r.u.unit.id, label: r.u.unit.title, tokens: r.tokensIn + r.tokensOut }))} onSelect={onSelect} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th><th>Unit</th><th>Changes</th><th>Ran on</th><th className="num">Attempts</th><th className="num">Work time</th>
              <th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Est. cost</th><th className="num">Findings</th><th className="num">Risks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.u.unit.id} className="clickable" onClick={() => onSelect(r.u.unit.id)}>
                <td><StatusBadge status={r.status} /></td>
                <td className="mono wrap">{r.u.unit.title}</td>
                <td><SevCounts changes={r.u.unit.changes} /> <span className="muted">{r.u.unit.changes.length}</span></td>
                <td className="mono">{[...new Set(r.u.calls.map((c) => c.endpoint ?? c.provider ?? "?"))].join(", ") || "–"}</td>
                <td className="num">{r.u.attempts.length}</td>
                <td className="num">{r.workMs ? secs(r.workMs) : "–"}</td>
                <td className="num">{tok(r.tokensIn)}</td>
                <td className="num">{tok(r.tokensOut)}</td>
                <td className="num">{usd(r.cost)}</td>
                <td className="num">{r.analysis?.findings.length ?? "–"}</td>
                <td className="num">{r.analysis?.risks.length ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Single-series horizontal bars (one hue, no legend), value labels at bar ends, hover tooltip. */
function TokenBars({ rows, onSelect }: { rows: { id: string; label: string; tokens: number }[]; onSelect: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  const max = Math.max(1, ...sorted.map((r) => r.tokens));
  return (
    <figure className="chart">
      <figcaption>Tokens per unit (input + output, all attempts)</figcaption>
      <div className="hbars" role="list">
        {sorted.map((r) => (
          <div key={r.id} role="listitem" className={`hbar-row${hover === r.id ? " hover" : ""}`}
            onMouseEnter={() => setHover(r.id)} onMouseLeave={() => setHover(null)} onClick={() => onSelect(r.id)}
            title={`${r.label}: ${r.tokens.toLocaleString()} tokens`}>
            <span className="hbar-label mono">{r.label}</span>
            <span className="hbar-track">
              <span className="hbar" style={{ width: `${(r.tokens / max) * 100}%` }} />
              <span className="hbar-value">{tok(r.tokens)}</span>
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

// ---- Inference ---------------------------------------------------------------

export function InferenceView({ state, onOpen, openSeq }: { state: RunState; onOpen: (c: LlmCall) => void; openSeq: number | null }) {
  const [role, setRole] = useState<"all" | "worker" | "lead">("all");
  const [query, setQuery] = useState("");
  const t0 = state.t0 ?? 0;
  const calls = state.calls.filter(
    (c) =>
      (role === "all" || c.role === role) &&
      (!query || `${c.unitId ?? "lead"} ${c.model} ${c.stopReason} ${c.output ?? ""}`.toLowerCase().includes(query.toLowerCase())),
  );
  const byModel = useMemo(() => {
    const m = new Map<string, { calls: number; in: number; out: number; ms: number; cost: number | null }>();
    for (const c of state.calls) {
      const row = m.get(c.model) ?? { calls: 0, in: 0, out: 0, ms: 0, cost: null };
      row.calls++;
      row.in += c.usage.inputTokens;
      row.out += c.usage.outputTokens;
      row.ms += c.durationMs;
      const cost = callCost(c);
      if (cost !== null) row.cost = (row.cost ?? 0) + cost;
      m.set(c.model, row);
    }
    return [...m.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.calls.length]);

  if (state.calls.length === 0) return <Empty>No LLM calls yet{state.start?.agents ? "" : ": agents were not run for this comparison"}.</Empty>;
  const latencies = state.calls.map((c) => c.durationMs).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!;

  return (
    <div className="stack">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Model</th><th className="num">Calls</th><th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Avg latency</th><th className="num">Est. cost</th></tr></thead>
          <tbody>
            {byModel.map(([model, r]) => (
              <tr key={model}>
                <td className="mono">{model}</td><td className="num">{r.calls}</td><td className="num">{tok(r.in)}</td><td className="num">{tok(r.out)}</td>
                <td className="num">{secs(r.ms / r.calls)}</td><td className="num">{usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Latency p50 {secs(pct(50))} · p90 {secs(pct(90))} · max {secs(latencies.at(-1)!)}. Costs are estimates from list prices.</p>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by role">
          {(["all", "worker", "lead"] as const).map((r) => (
            <button key={r} className={role === r ? "active" : ""} onClick={() => setRole(r)}>{r === "all" ? "All" : r === "worker" ? "Workers" : "Lead"}</button>
          ))}
        </div>
        <input type="search" placeholder="Filter by unit, model or output text" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="muted small">{calls.length} of {state.calls.length} calls</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>At</th><th>Role</th><th>Unit</th><th>Model</th><th>Endpoint</th><th className="num">Latency</th><th className="num">In</th><th className="num">Out</th><th className="num">Cached</th><th className="num">Est. cost</th><th>Stop</th></tr>
          </thead>
          <tbody>
            {calls.map((c, i) => (
              <tr key={c.seq} className={`clickable${openSeq === c.seq ? " selected" : ""}`} onClick={() => onOpen(c)}>
                <td className="num muted">{i + 1}</td>
                <td className="mono">+{secs(c.t - t0)}</td>
                <td>{c.role}</td>
                <td className="mono wrap">{c.unitId ?? "—"}</td>
                <td className="mono">{c.model}</td>
                <td className="mono">{c.endpoint ?? (c.provider === "claude" ? "API" : "–")}</td>
                <td className="num">{secs(c.durationMs)}</td>
                <td className="num">{tok(c.usage.inputTokens)}</td>
                <td className="num">{tok(c.usage.outputTokens)}</td>
                <td className="num">{tok(c.usage.cacheReadTokens)}</td>
                <td className="num">{usd(callCost(c))}</td>
                <td>{c.stopReason === "refusal" ? <SevChip severity="breaking">refusal</SevChip> : c.stopReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Changes -----------------------------------------------------------------

export function ChangesView({ state, onSelect }: { state: RunState; onSelect: (unitId: string) => void }) {
  const [show, setShow] = useState<Record<Severity, boolean>>({ breaking: true, warning: true, info: false });
  const units = [...state.units.values()];
  const counts = { breaking: 0, warning: 0, info: 0 };
  for (const u of units) for (const c of u.unit.changes) counts[c.severity]++;
  return (
    <div className="stack">
      <div className="toolbar">
        {(["breaking", "warning", "info"] as const).map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={show[s]} onChange={() => setShow({ ...show, [s]: !show[s] })} />
            <SevChip severity={s} /> {counts[s]}
          </label>
        ))}
      </div>
      {units.map((u) => {
        const changes = u.unit.changes.filter((c) => show[c.severity]);
        if (changes.length === 0) return null;
        return (
          <section key={u.unit.id} className="change-group">
            <h3><button className="btn-link mono" onClick={() => onSelect(u.unit.id)}>{u.unit.title}</button> <span className="muted">({u.unit.status})</span></h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Severity</th><th>Location</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.id}>
                      <td><SevChip severity={c.severity} /></td>
                      <td className="mono wrap">{c.location}</td>
                      <td>{c.message}</td>
                      <td className="mono wrap muted">{fmtValue(c.before)}</td>
                      <td className="mono wrap muted">{fmtValue(c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---- Risks -------------------------------------------------------------------

const RISK_ORDER = ["critical", "high", "medium", "low"] as const;

export function RisksView({ state, onSelect }: { state: RunState; onSelect: (unitId: string) => void }) {
  const report = state.lead.report;
  if (!report) {
    const perUnit = [...state.units.values()].flatMap((u) => (latestAnalysis(u)?.risks ?? []).map((r) => ({ r, unitId: u.unit.id })));
    return (
      <div className="stack">
        <p className="muted">
          {state.lead.status === "failed" ? `The lead agent failed: ${state.lead.error}. ` : state.lead.status === "running" ? "The lead agent is still working. " : "No final risk report. "}
          {perUnit.length > 0 ? "Risks reported by individual workers:" : ""}
        </p>
        {perUnit.length === 0 ? <Empty>No risks reported yet.</Empty> : (
          <ul className="cards">
            {perUnit.map(({ r, unitId }, i) => (
              <li key={i}>
                <div className="card-title"><SevChip severity={r.impact}>impact {r.impact}</SevChip> <span>{r.description}</span></div>
                <div className="muted">Scenario: {r.failureScenario}</div>
                <button className="btn-link mono" onClick={() => onSelect(unitId)}>{unitId}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const risks = [...report.risks].sort((a, b) => RISK_ORDER.indexOf(a.severity) - RISK_ORDER.indexOf(b.severity));
  return (
    <div className="stack">
      <p className="summary">{report.overview}</p>
      <ol className="cards risks">
        {risks.map((r, i) => (
          <li key={i}>
            <div className="card-title"><SevChip severity={r.severity} /> <strong>{r.title}</strong> <span className="muted">likelihood {r.likelihood}</span></div>
            <div>{r.description}</div>
            <div className="muted">Failure scenario: {r.failureScenario}</div>
            <div className="muted">Mitigation: {r.mitigation}</div>
            <div className="unit-links">{r.affectedUnits.map((id) => <button key={id} className="btn-link mono" onClick={() => onSelect(id)}>{id}</button>)}</div>
          </li>
        ))}
      </ol>
      {report.crossCuttingNotes.length > 0 && (
        <>
          <h3>Cross-cutting notes</h3>
          <ul className="cards">{report.crossCuttingNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </>
      )}
    </div>
  );
}

// ---- Events --------------------------------------------------------------------

export function describeEvent(e: RunEvent): string {
  switch (e.type) {
    case "run-start": return `${e.units.length} units · ${e.format}${e.agents ? ` · concurrency ${e.concurrency}` : " · no agents"}${e.simulated ? " · simulated" : ""}`;
    case "unit-start": return `${e.unitId}${e.question ? ` · follow-up: ${e.question}` : ""}`;
    case "unit-done": return `${e.unitId} · ${secs(e.durationMs)} · ${e.analysis.findings.length} findings, ${e.analysis.risks.length} risks`;
    case "unit-failed": return `${e.unitId} · ${e.error}`;
    case "unit-skipped": return `${e.unitId} · ${e.reason}`;
    case "unit-reused": return `${e.unitId} · analysis reused from run ${e.fromRun}`;
    case "llm-call": return `${e.role}${e.unitId ? ` ${e.unitId}` : ""} · ${e.model} · ${secs(e.durationMs)} · ${tok(e.usage.inputTokens)} in / ${tok(e.usage.outputTokens)} out · ${e.stopReason}`;
    case "lead-tool-call": return `${e.tool} ${JSON.stringify(e.input)}`;
    case "lead-text": return e.text;
    case "synthesis-start": return "";
    case "synthesis-done": return `${secs(e.durationMs)} · ${e.riskReport.risks.length} risks`;
    case "synthesis-failed": return e.error;
    case "run-end": return `${secs(e.durationMs)}${e.failedUnits ? ` · ${e.failedUnits} failed units` : ""}${e.stopped ? ` · stopped (${e.stopped})` : ""}${e.error ? `: ${e.error}` : ""}`;
  }
}

export function EventsView({ state }: { state: RunState }) {
  const [query, setQuery] = useState("");
  const t0 = state.t0 ?? 0;
  const events = state.events.filter((e) => !query || `${e.type} ${describeEvent(e)}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="stack">
      <div className="toolbar">
        <input type="search" placeholder="Filter events" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="muted small">{events.length} of {state.events.length} events</span>
      </div>
      <div className="event-log">
        {events.slice(-2000).map((e) => (
          <div key={e.seq} className={`ev${e.type.endsWith("failed") || (e.type === "run-end" && (e.failedUnits > 0 || e.stopped)) ? " bad" : ""}`}>
            <span className="ev-t">+{secs(e.t - t0)}</span>
            <span className="ev-type">{e.type}</span>
            <span className="ev-msg">{describeEvent(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
