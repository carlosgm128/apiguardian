import { useEffect, useState } from "react";
import { api, type ApiDetail } from "../api";
import { HeadersEditor, headersFromRows, intervalLabel, IntervalSelect, ReportAgentsPicker, type HeaderRow } from "../components/ApiForms";
import { Empty, Panel, SevChip, StatusBadge } from "../components/ui";
import { navigate, usePoll } from "../hooks/hooks";
import { ago, secs } from "../lib/format";
import type { CheckRecord, RunConfig, RunMeta, Snapshot } from "../types";

const OUTCOMES: Record<CheckRecord["outcome"], { status: string; label: string }> = {
  baseline: { status: "done", label: "First snapshot" },
  unchanged: { status: "skipped", label: "Unchanged" },
  changed: { status: "running", label: "New version" },
  error: { status: "failed", label: "Check failed" },
};

export function OutcomeBadge({ outcome }: { outcome: CheckRecord["outcome"] }) {
  const o = OUTCOMES[outcome];
  // "changed" is news, not activity: show it with the done tone but its own label.
  return <StatusBadge status={outcome === "changed" ? "done" : o.status} label={o.label} />;
}

export function ApiDetailPage({ id }: { id: string }) {
  const { data, error, refresh } = usePoll(() => api.api(id), 5000, [id]);
  const { data: runs } = usePoll(api.runs, 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error && !data) return <Panel title="Tracked API"><Empty>{error}</Empty></Panel>;
  if (!data) return <Panel title="Tracked API"><Empty>Loading…</Empty></Panel>;
  const { api: tracked, versions, checks } = data;
  const runsById = new Map((runs ?? []).map((r) => [r.id, r]));

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack-lg">
      <header className="run-head">
        <div className="run-title">
          <button className="btn-link" onClick={() => navigate("apis")}>← APIs</button>
          <h1>{tracked.name}</h1>
        </div>
        <div className="run-meta">
          {tracked.lastOutcome && <OutcomeBadge outcome={tracked.lastOutcome} />}
          <span className="pill">{tracked.enabled ? intervalLabel(tracked.intervalMinutes) : "Paused"}</span>
          <span className="pill mono">{versions.length} version{versions.length === 1 ? "" : "s"}</span>
          <span className="muted small mono wrap">{tracked.url}</span>
          <span className="spacer" />
          <button className="btn primary" disabled={busy !== null} onClick={() => act("check", () => api.checkApi(id))}>{busy === "check" ? "Checking…" : "Check now"}</button>
          <button className="btn" disabled={busy !== null} onClick={() => act("toggle", () => api.updateApi(id, { enabled: !tracked.enabled }))}>{tracked.enabled ? "Pause" : "Resume"}</button>
        </div>
        <p className="muted small">
          {tracked.lastCheckedAt ? `Last checked ${ago(tracked.lastCheckedAt)}` : "Not checked yet"}
          {tracked.enabled && tracked.nextCheckAt ? ` · next check ${new Date(tracked.nextCheckAt).toLocaleString()}` : ""}
        </p>
        {tracked.lastError && <p className="error">{tracked.lastError}</p>}
        {actionError && <p className="error">{actionError}</p>}
      </header>

      <Panel title="Version history" actions={<span className="muted small">newest first</span>}>
        <ol className="history">
          {versions.map((v, i) => (
            <VersionItem key={v.id} apiId={id} version={v} previous={versions[i + 1]} run={v.runId ? runsById.get(v.runId) : undefined} />
          ))}
        </ol>
        {versions.length >= 2 && <CompareBar apiId={id} versions={versions} />}
      </Panel>

      <SettingsPanel data={data} onSaved={refresh} />

      <Panel title="Checks" actions={<span className="muted small">latest 100</span>}>
        {checks.length === 0 ? <Empty>No checks yet.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Trigger</th><th>Result</th><th className="num">HTTP</th><th className="num">Took</th><th>Version</th><th>Details</th></tr></thead>
              <tbody>
                {checks.map((c, i) => (
                  <tr key={i}>
                    <td title={c.at}>{ago(c.at)}</td>
                    <td>{c.trigger}</td>
                    <td><OutcomeBadge outcome={c.outcome} /></td>
                    <td className="num">{c.status ?? "–"}</td>
                    <td className="num">{secs(c.durationMs)}</td>
                    <td className="mono">{c.snapshotId ? `#${Number(c.snapshotId.split("-")[0])}` : "–"}</td>
                    <td className="wrap">
                      {c.runId && <button className="btn-link" onClick={() => navigate("runs", c.runId!)}>report</button>}
                      {c.error && <span className="error">{c.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Danger zone">
        <div className="pad toolbar">
          <span className="muted small">Stops tracking and deletes the stored snapshots and check log. Reports already written stay in Runs.</span>
          <span className="spacer" />
          <button
            className="btn danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(`Stop tracking ${tracked.name} and delete its ${versions.length} snapshots?`)) {
                void act("delete", () => api.deleteApi(id)).then(() => navigate("apis"));
              }
            }}
          >
            Stop tracking
          </button>
        </div>
      </Panel>
    </div>
  );
}

function VersionItem({ apiId, version: v, previous, run }: { apiId: string; version: Snapshot; previous?: Snapshot; run?: RunMeta }) {
  const opsDelta = previous ? v.summary.operations - previous.summary.operations : 0;
  return (
    <li className="version">
      <div className="version-marker" aria-hidden />
      <div className="version-body">
        <div className="version-head">
          <span className="strong mono">#{v.seq}</span>
          <span className="strong">v{v.summary.version ?? "?"}</span>
          <span className="muted small" title={v.fetchedAt}>{new Date(v.fetchedAt).toLocaleString()} · {ago(v.fetchedAt)}</span>
        </div>
        <div className="version-meta small">
          <span>{v.summary.specVersion === "2.0" ? "Swagger 2.0" : `OpenAPI ${v.summary.specVersion}`}</span>
          <span>{v.summary.operations} operations{previous && opsDelta !== 0 ? ` (${opsDelta > 0 ? "+" : ""}${opsDelta})` : ""}</span>
          <span className="mono muted">{v.hash.slice(0, 12)}</span>
          <a className="btn-link" href={api.snapshotUrl(apiId, v.id)}>spec</a>
        </div>
        {!previous && <div className="muted small">First snapshot: the baseline later versions are compared with.</div>}
        {previous && (
          <div className="version-change">
            {run ? (
              <>
                <StatusBadge status={run.status} />
                {run.summary.breaking > 0 && <SevChip severity="breaking">{run.summary.breaking} breaking</SevChip>}
                {run.summary.warnings > 0 && <SevChip severity="warning">{run.summary.warnings} warning</SevChip>}
                {run.summary.breaking === 0 && run.summary.warnings === 0 && run.status === "done" && <span className="muted small">no breaking changes</span>}
                {run.summary.risks !== undefined && <span className="small">{run.summary.risks} risks</span>}
                <span className="muted small">vs #{previous.seq}</span>
                <button className="btn-link" onClick={() => navigate("runs", run.id)}>Open report</button>
              </>
            ) : v.runError ? (
              <span className="error small">Report could not start: {v.runError}</span>
            ) : (
              <span className="muted small">Report {v.runId ?? ""} not found</span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function CompareBar({ apiId, versions }: { apiId: string; versions: Snapshot[] }) {
  const [from, setFrom] = useState(versions.at(-1)!.id);
  const [to, setTo] = useState(versions[0]!.id);
  const [error, setError] = useState<string | null>(null);
  const label = (v: Snapshot) => `#${v.seq} · v${v.summary.version ?? "?"} · ${new Date(v.fetchedAt).toLocaleDateString()}`;
  return (
    <div className="pad toolbar compare-bar">
      <span className="strong small">Compare any two versions</span>
      <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Older version">{versions.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}</select>
      <span aria-hidden>→</span>
      <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Newer version">{versions.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}</select>
      <button
        className="btn"
        disabled={from === to}
        onClick={async () => {
          try {
            const run = await api.compareApi(apiId, from, to);
            navigate("runs", run.id);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Compare
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

function SettingsPanel({ data, onSaved }: { data: ApiDetail; onSaved: () => Promise<void> }) {
  const { api: tracked } = data;
  const { data: status } = usePoll(api.status, 0);
  const [name, setName] = useState(tracked.name);
  const [url, setUrl] = useState(tracked.url);
  const [intervalMinutes, setIntervalMinutes] = useState(tracked.intervalMinutes);
  const [agents, setAgents] = useState<Partial<RunConfig>>(tracked.agents);
  const [headers, setHeaders] = useState<HeaderRow[]>(Object.entries(tracked.headers).map(([n, v]) => ({ name: n, value: v })));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setState("idle"), [name, url, intervalMinutes, agents, headers]);

  return (
    <Panel title="Settings">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("saving");
          setError(null);
          try {
            await api.updateApi(tracked.id, { name, url, intervalMinutes, agents, headers: headersFromRows(headers) });
            await onSaved();
            setState("saved");
          } catch (err) {
            setError((err as Error).message);
            setState("idle");
          }
        }}
      >
        <div className="row2">
          <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>How often to fetch the spec<IntervalSelect value={intervalMinutes} onChange={setIntervalMinutes} /></label>
        </div>
        <label>Spec URL<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <div>
          <div className="label">Request headers</div>
          <HeadersEditor rows={headers} onChange={setHeaders} />
          <p className="hint">Saved values show as dots; leave them as they are to keep them.</p>
        </div>
        <div>
          <div className="label">Report for each new version</div>
          <ReportAgentsPicker value={agents} onChange={setAgents} status={status} />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {state === "saved" && <span className="muted small">Saved</span>}
          <button type="submit" className="btn primary" disabled={state === "saving"}>{state === "saving" ? "Saving…" : "Save settings"}</button>
        </div>
      </form>
    </Panel>
  );
}
