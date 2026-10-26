import { useState, type FormEvent } from "react";
import { api, type NewApiRequest } from "../api";
import { HeadersEditor, headersFromRows, intervalLabel, IntervalSelect, ReportAgentsPicker, type HeaderRow } from "../components/ApiForms";
import { Empty, Panel } from "../components/ui";
import { navigate, usePoll } from "../hooks/hooks";
import { agentsLabel, ago } from "../lib/format";
import type { RunConfig, SpecSummary } from "../types";
import { OutcomeBadge } from "./ApiDetailPage";

export function ApisPage() {
  const { data: apis, error, refresh } = usePoll(api.apis, 5000);
  const [adding, setAdding] = useState(false);

  return (
    <div className="stack-lg">
      <Panel title="Tracked APIs" actions={!adding && <button className="btn primary" onClick={() => setAdding(true)}>Track an API</button>}>
        {adding && <AddApiForm onDone={(id) => (id ? navigate("apis", id) : setAdding(false), void refresh())} />}
        {error && <p className="error pad">{error}</p>}
        {apis && apis.length === 0 && !adding && (
          <Empty>
            No APIs tracked yet. Give apiguardian a Swagger/OpenAPI URL and it will snapshot the spec, check it on a schedule, and write a
            report every time it changes. <button className="btn-link" onClick={() => setAdding(true)}>Track an API</button>
          </Empty>
        )}
        {apis && apis.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>API</th><th>Current version</th><th className="num">Versions</th><th>Last check</th><th>Schedule</th><th>Reports by</th></tr>
              </thead>
              <tbody>
                {apis.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => navigate("apis", a.id)}>
                    <td>
                      <div className="strong">{a.name}</div>
                      <div className="muted small mono wrap">{a.url}</div>
                    </td>
                    <td className="mono">{a.latest ? `v${a.latest.summary.version ?? "?"}` : "–"}<div className="muted small">{a.latest ? `${a.latest.summary.operations} operations` : ""}</div></td>
                    <td className="num">{a.versions}</td>
                    <td>
                      {a.lastOutcome ? <OutcomeBadge outcome={a.lastOutcome} /> : "–"}
                      <div className="muted small">{a.lastCheckedAt ? ago(a.lastCheckedAt) : ""}</div>
                    </td>
                    <td>{a.enabled ? intervalLabel(a.intervalMinutes) : <span className="muted">Paused</span>}{a.nextCheckAt && a.enabled ? <div className="muted small">next {new Date(a.nextCheckAt).toLocaleTimeString()}</div> : null}</td>
                    <td>
                      {agentsLabel(a.agents)}
                      {(a.agents.workerModel || a.agents.leadModel) && (
                        <div className="muted small mono">
                          {a.agents.workerModel ?? "default"}{a.agents.leadModel !== a.agents.workerModel ? ` → ${a.agents.leadModel ?? "default"}` : ""}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function AddApiForm({ onDone }: { onDone: (id?: string) => void }) {
  const { data: status } = usePoll(api.status, 0);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [agents, setAgents] = useState<Partial<RunConfig>>({ mode: "diff" });
  const [found, setFound] = useState<{ url: string; summary: SpecSummary } | null>(null);
  const [busy, setBusy] = useState<"detect" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function detect() {
    setBusy("detect");
    setError(null);
    setFound(null);
    try {
      const result = await api.discover(url.trim(), headersFromRows(headers));
      setFound(result);
      if (!name) setName(result.summary.title ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    setError(null);
    try {
      const req: NewApiRequest = { url: found?.url ?? url.trim(), name: name.trim() || undefined, headers: headersFromRows(headers), intervalMinutes, agents };
      const created = await api.addApi(req);
      onDone(created.api.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <fieldset>
        <legend>API</legend>
        <label>
          Spec URL or the API's base URL
          <div className="input-row">
            <input type="url" required placeholder="https://api.example.com/openapi.json or https://api.example.com" value={url} onChange={(e) => (setUrl(e.target.value), setFound(null))} />
            <button type="button" className="btn" disabled={!url || busy !== null} onClick={detect}>{busy === "detect" ? "Detecting…" : "Detect"}</button>
          </div>
        </label>
        {found && (
          <p className="ok-box">
            Found <strong>{found.summary.title ?? "an API"}</strong> v{found.summary.version ?? "?"} ({found.summary.specVersion === "2.0" ? "Swagger 2.0" : `OpenAPI ${found.summary.specVersion}`}, {found.summary.operations} operations) at <code>{found.url}</code>
          </p>
        )}
        <p className="hint">With a base URL, apiguardian looks for the spec at the usual paths (/openapi.json, /v3/api-docs, /swagger.json, …).</p>
        <label>Name<input type="text" placeholder="Defaults to the spec's title" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div>
          <div className="label">Request headers (if the spec needs auth)</div>
          <HeadersEditor rows={headers} onChange={setHeaders} />
          <p className="hint">Stored in the server's tracked-API folder (readable only by you) and never shown again.</p>
        </div>
      </fieldset>
      <fieldset>
        <legend>Checks</legend>
        <label>How often to fetch the spec<IntervalSelect value={intervalMinutes} onChange={setIntervalMinutes} /></label>
        <p className="hint">Checks run while <code>apiguardian serve</code> is running. For a server that isn't always up, schedule <code>apiguardian check-apis</code> with cron.</p>
      </fieldset>
      <fieldset>
        <legend>Report for each new version</legend>
        <ReportAgentsPicker value={agents} onChange={setAgents} status={status} />
      </fieldset>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => onDone()}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!url || busy !== null}>{busy === "save" ? "Taking first snapshot…" : "Start tracking"}</button>
      </div>
    </form>
  );
}
