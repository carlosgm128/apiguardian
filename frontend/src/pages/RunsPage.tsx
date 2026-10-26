import { api } from "../api";
import { Empty, Panel, StatusBadge } from "../components/ui";
import { navigate, usePoll } from "../hooks/hooks";
import { agentsLabel, ago, secs, tok, usd } from "../lib/format";
import { estimateCost, sumCosts } from "../lib/pricing";
import type { RunMeta } from "../types";

export function runCost(run: RunMeta): number | null {
  return sumCosts(Object.entries(run.summary.usageByModel).map(([model, usage]) => estimateCost(model, usage, usage.provider)));
}

export function RunsPage() {
  const { data: runs, error } = usePoll(api.runs, 2000);

  return (
    <Panel title="Runs" actions={<button className="btn primary" onClick={() => navigate("new")}>New run</button>}>
      {error && <p className="error pad">Could not load runs: {error}</p>}
      {runs && runs.length === 0 && (
        <Empty>
          No runs yet. <button className="btn-link" onClick={() => navigate("new")}>Start one</button> from a sample or your own docs.
        </Empty>
      )}
      {runs && runs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th><th>Comparison</th><th>Mode</th><th>Started</th><th className="num">Duration</th>
                <th className="num">Units</th><th className="num">Breaking</th><th className="num">LLM calls</th><th className="num">Tokens</th><th className="num">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate("runs", r.id)}>
                  <td><StatusBadge status={r.status} /></td>
                  <td>
                    <div className="mono">{r.baselineName} → {r.candidateName}</div>
                    <div className="muted small">{r.id}{r.origin ? ` · tracked API ${r.origin.apiName}` : r.source !== "dashboard" ? ` · ${r.source}` : ""}{r.error ? ` · ${r.error}` : ""}</div>
                  </td>
                  <td>{agentsLabel(r.config)}{r.config.workerModel ? <div className="muted small mono">{r.config.workerModel}{r.config.leadModel && r.config.leadModel !== r.config.workerModel ? ` · lead ${r.config.leadModel}` : ""}</div> : null}</td>
                  <td title={r.createdAt}>{ago(r.createdAt)}</td>
                  <td className="num">{r.summary.durationMs !== undefined ? secs(r.summary.durationMs) : r.status === "running" ? secs(Date.now() - Date.parse(r.createdAt)) : "–"}</td>
                  <td className="num">{r.summary.units}</td>
                  <td className="num">{r.summary.breaking}</td>
                  <td className="num">{r.summary.llmCalls}</td>
                  <td className="num">{tok(r.summary.inputTokens + r.summary.outputTokens)}</td>
                  <td className="num">{usd(runCost(r))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
