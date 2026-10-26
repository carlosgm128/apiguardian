import type { ReactNode } from "react";
import { fmtValue, secs, tok, usd } from "../lib/format";
import { callCost, unitStatus, type LeadState, type RunState, type UnitState } from "../state/runState";
import type { LlmCall, UnitAnalysis } from "../types";
import { CodeBlock, Empty, KeyValues, SevChip, StatusBadge } from "./ui";

export function AnalysisView({ analysis }: { analysis: UnitAnalysis }) {
  return (
    <div className="stack">
      <p className="summary">{analysis.summary}</p>
      {analysis.findings.length > 0 && (
        <ul className="cards">
          {analysis.findings.map((f, i) => (
            <li key={i}>
              <div className="card-title"><SevChip severity={f.severity} /> <strong>{f.title}</strong></div>
              <div className="mono muted">{f.baselineRef}</div>
              <div>{f.what}</div>
              <div className="muted">{f.how}</div>
            </li>
          ))}
        </ul>
      )}
      {analysis.risks.length > 0 && (
        <>
          <h4>Risks</h4>
          <ul className="cards">
            {analysis.risks.map((r, i) => (
              <li key={i}>
                <div className="card-title"><SevChip severity={r.impact}>impact {r.impact}</SevChip> <span>{r.description}</span></div>
                <div className="muted">Scenario: {r.failureScenario}</div>
                <div className="muted">Affected: {r.affectedConsumers} · likelihood {r.likelihood}</div>
                <div className="muted">Mitigation: {r.mitigation}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function CallsTable({ calls, t0, onOpen }: { calls: LlmCall[]; t0: number; onOpen?: (call: LlmCall) => void }) {
  if (calls.length === 0) return <p className="muted">No LLM calls yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>At</th><th>Model</th><th className="num">Time</th><th className="num">In</th><th className="num">Out</th><th className="num">Cached</th><th className="num">Est. cost</th><th>Stop</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.seq} className={onOpen ? "clickable" : ""} onClick={() => onOpen?.(c)}>
              <td className="mono">+{secs(c.t - t0)}</td>
              <td className="mono">{c.model}</td>
              <td className="num">{secs(c.durationMs)}</td>
              <td className="num">{tok(c.usage.inputTokens)}</td>
              <td className="num">{tok(c.usage.outputTokens)}</td>
              <td className="num">{tok(c.usage.cacheReadTokens)}</td>
              <td className="num">{usd(callCost(c))}</td>
              <td>{c.stopReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UnitDetail({ u, state, onOpenCall }: { u: UnitState; state: RunState; onOpenCall: (c: LlmCall) => void }) {
  const status = unitStatus(state, u);
  const t0 = state.t0 ?? 0;
  return (
    <div className="stack">
      <div>
        <div className="mono strong wrap">{u.unit.title}</div>
        <KeyValues
          rows={[
            ["Status", <StatusBadge status={status} />],
            ["Change", `${u.unit.status} ${u.unit.format} unit`],
            ["Unit id", <span className="mono">{u.unit.id}</span>],
            ["Attempts", u.attempts.map((a) => `${a.question ? "follow-up" : "worker"} ${a.status}${a.end !== null ? ` in ${secs(a.end - a.start)}` : ""}`).join(", ") || "none"],
          ]}
        />
      </div>

      <section>
        <h3>Deterministic changes ({u.unit.changes.length})</h3>
        <ul className="cards">
          {u.unit.changes.map((c) => (
            <li key={c.id}>
              <div className="card-title"><SevChip severity={c.severity} /> <span>{c.message}</span></div>
              <div className="mono muted">{c.location}</div>
              {(c.before !== undefined || c.after !== undefined) && <div className="muted">{fmtValue(c.before)} → {fmtValue(c.after)}</div>}
            </li>
          ))}
        </ul>
      </section>

      {u.attempts.map((a, i) => (
        <section key={i} className={a.question ? "followup" : ""}>
          <h3>{a.question ? "Follow-up from lead" : a.reusedFrom ? `Worker analysis (reused from run ${a.reusedFrom})` : "Worker analysis"}</h3>
          {a.question && <p className="question">{a.question}</p>}
          {a.status === "running" && <p className="muted">Running…</p>}
          {a.status === "failed" && <p className="error">{a.error}</p>}
          {a.analysis && <AnalysisView analysis={a.analysis} />}
        </section>
      ))}

      <section>
        <h3>LLM calls</h3>
        <CallsTable calls={u.calls} t0={t0} onOpen={onOpenCall} />
      </section>

      {u.unit.diff && <CodeBlock title="Text diff" text={u.unit.diff} />}
    </div>
  );
}

export function LeadDetail({ lead, state, now, onOpenCall }: { lead: LeadState; state: RunState; now: number; onOpenCall: (c: LlmCall) => void }) {
  if (!state.start?.agents) return <Empty>Agents were not run for this comparison. Select a unit to see its changes.</Empty>;
  const t0 = state.t0 ?? 0;
  return (
    <div className="stack">
      <KeyValues
        rows={[
          ["Status", <StatusBadge status={lead.status === "idle" && state.end ? "not-run" : lead.status} />],
          ["Duration", lead.start !== null ? secs((lead.end ?? now) - lead.start) : "not started"],
          ["LLM turns", String(lead.calls.length)],
          ["Est. cost", usd(lead.calls.reduce<number | null>((n, c) => { const x = callCost(c); return x === null ? n : (n ?? 0) + x; }, null))],
        ]}
      />
      <section>
        <h3>Activity</h3>
        {lead.items.length === 0 ? (
          <p className="muted">{lead.status === "idle" ? (state.end ? "The run stopped before the lead agent started." : "Waiting for the workers to finish.") : "No activity yet."}</p>
        ) : (
          <ol className="activity">
            {lead.items.map((it, i) => (
              <li key={i} className={`act act-${it.kind}`}>
                <span className="mono muted">+{secs(it.event.t - t0)}</span>{" "}
                {it.kind === "text" && <span>{it.event.text}</span>}
                {it.kind === "tool" && (
                  <>
                    <span>called <b className="mono">{it.event.tool}</b></span>
                    <pre>{JSON.stringify(it.event.input, null, 2)}</pre>
                  </>
                )}
                {it.kind === "llm" && (
                  <button className="btn-link" onClick={() => onOpenCall(it.event)}>
                    LLM turn · {secs(it.event.durationMs)} · {tok(it.event.usage.inputTokens)} in / {tok(it.event.usage.outputTokens)} out · {it.event.stopReason}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {lead.error && <p className="error">{lead.error}</p>}
    </div>
  );
}

export function CallDetail({ call, t0 }: { call: LlmCall; t0: number }) {
  const u = call.usage;
  return (
    <div className="stack">
      <KeyValues
        rows={[
          ["Role", call.role === "lead" ? "Lead agent" : "Worker"],
          ...(call.unitId ? [["Unit", <span className="mono">{call.unitId}</span>] as [string, ReactNode]] : []),
          ["Model", <span className="mono">{call.model}</span>],
          ...(call.endpoint ? [["Endpoint", <span className="mono">{call.endpoint}</span>] as [string, ReactNode]] : []),
          ["Started", `+${secs(call.t - call.durationMs - t0)}`],
          ["Latency", secs(call.durationMs)],
          ["Tokens", `${tok(u.inputTokens)} in · ${tok(u.outputTokens)} out · ${tok(u.cacheReadTokens)} cache read · ${tok(u.cacheWriteTokens)} cache write`],
          ["Output speed", call.durationMs > 0 ? `${Math.round(u.outputTokens / (call.durationMs / 1000))} tok/s` : "–"],
          ["Est. cost", usd(callCost(call))],
          ["Stop reason", call.stopReason ?? "–"],
        ]}
      />
      {call.prompt?.system && <CodeBlock title="System prompt" text={call.prompt.system} collapsedLines={8} />}
      {call.prompt && <CodeBlock title={call.role === "lead" && !call.prompt.system ? "Input (tool results)" : "User prompt"} text={call.prompt.user} />}
      {call.output !== undefined && <CodeBlock title="Output" text={call.output} />}
      {!call.prompt && call.output === undefined && <p className="muted">This run did not capture prompts or outputs.</p>}
    </div>
  );
}
