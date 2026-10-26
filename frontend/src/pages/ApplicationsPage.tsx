import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Operation } from "../api";
import { ImpactList } from "../components/Impacts";
import { Empty, Panel, SevChip } from "../components/ui";
import { navigate, usePoll } from "../hooks/hooks";
import { ago } from "../lib/format";
import { parseOperationList } from "../lib/operations";
import type { Application, Dependency, Severity } from "../types";

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: "breaking", label: "Breaking changes only" },
  { value: "warning", label: "Breaking changes and warnings" },
  { value: "info", label: "Every change" },
];

export function ApplicationsPage() {
  const { data: apps, error, refresh } = usePoll(api.applications, 10_000);
  const [adding, setAdding] = useState(false);
  return (
    <Panel title="Applications" actions={!adding && <button className="btn primary" onClick={() => setAdding(true)}>Add application</button>}>
      {adding && <NewApplicationForm onDone={(id) => (id ? navigate("apps", id) : setAdding(false), void refresh())} />}
      {error && <p className="error pad">{error}</p>}
      {apps && apps.length === 0 && !adding && (
        <Empty>
          No applications yet. Add the applications that consume your tracked APIs, list the operations each one calls, and choose who gets
          notified when one of them changes. <button className="btn-link" onClick={() => setAdding(true)}>Add application</button>
        </Empty>
      )}
      {apps && apps.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Application</th><th>Owner</th><th className="num">APIs used</th><th className="num">Channels</th><th>Breaking (30 days)</th><th>Last impact</th></tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate("apps", a.id)}>
                  <td><div className="strong">{a.name}</div>{a.description && <div className="muted small">{a.description}</div>}</td>
                  <td>{a.owner ?? "–"}</td>
                  <td className="num">{a.dependencies.length}</td>
                  <td className="num">{a.channelIds.length}</td>
                  <td>{a.breaking30d > 0 ? <SevChip severity="breaking">{a.breaking30d}</SevChip> : <span className="muted">none</span>}</td>
                  <td>{a.lastImpact ? `${a.lastImpact.apiName} · ${ago(a.lastImpact.at)}` : <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function NewApplicationForm({ onDone }: { onDone: (id?: string) => void }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [contact, setContact] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
          const created = await api.createApplication({ name, owner: owner || undefined, contact: contact || undefined, description: description || undefined });
          onDone(created.app.id);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="row2">
        <label>Name<input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout web app" /></label>
        <label>Owner (team or person)<input type="text" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. payments-team" /></label>
        <label>Contact<input type="text" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="e.g. #payments-dev or lead@example.com" /></label>
        <label>Description<input type="text" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </div>
      <p className="hint">Next you'll choose which tracked APIs it uses and where to send notifications.</p>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => onDone()}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!name.trim() || busy}>{busy ? "Creating…" : "Create application"}</button>
      </div>
    </form>
  );
}

export function ApplicationDetailPage({ id }: { id: string }) {
  const { data, error, refresh } = usePoll(() => api.application(id), 10_000, [id]);
  const { data: trackedApis } = usePoll(api.apis, 0);
  const { data: channels } = usePoll(api.channels, 0);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (error && !data) return <Panel title="Application"><Empty>{error}</Empty></Panel>;
  if (!data) return <Panel title="Application"><Empty>Loading…</Empty></Panel>;
  const { app, impacts } = data;
  const apiName = (apiId: string) => trackedApis?.find((a) => a.id === apiId)?.name ?? apiId;

  const save = async (patch: Partial<Application>) => {
    setActionError(null);
    try {
      await api.updateApplication(id, patch);
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
      throw e;
    }
  };
  const saveDependency = async (dep: Dependency) => {
    await save({ dependencies: [...app.dependencies.filter((d) => d.apiId !== dep.apiId), dep] });
    setEditing(null);
  };

  return (
    <div className="stack-lg">
      <header className="run-head">
        <div className="run-title">
          <button className="btn-link" onClick={() => navigate("apps")}>← Applications</button>
          <h1>{app.name}</h1>
        </div>
        <div className="run-meta">
          {app.owner && <span className="pill">Owner: {app.owner}</span>}
          {app.contact && <span className="pill">Contact: {app.contact}</span>}
          <span className="pill">{app.dependencies.length} API{app.dependencies.length === 1 ? "" : "s"}</span>
          {app.description && <span className="muted small">{app.description}</span>}
        </div>
        {actionError && <p className="error">{actionError}</p>}
      </header>

      <Panel title="APIs this application uses" actions={editing === null && <button className="btn" onClick={() => setEditing("new")}>Add API</button>}>
        <div className="pad stack">
          {app.dependencies.length === 0 && editing === null && (
            <p className="muted">
              No APIs yet. Add the tracked APIs this application calls. If it only calls some operations, list them, and only changes to
              those operations (plus spec-wide changes like auth or servers) will count as affecting it.
            </p>
          )}
          {app.dependencies.map((d) =>
            editing === d.apiId ? (
              <DependencyEditor key={d.apiId} apiOptions={trackedApis ?? []} initial={d} onSave={saveDependency} onCancel={() => setEditing(null)} />
            ) : (
              <div key={d.apiId} className="dep-row">
                <div>
                  <button className="btn-link strong" onClick={() => navigate("apis", d.apiId)}>{apiName(d.apiId)}</button>
                  <div className="muted small">
                    {d.operations === "all" ? "All operations" : `${d.operations.length} operation${d.operations.length === 1 ? "" : "s"}: `}
                    {d.operations !== "all" && <span className="mono">{d.operations.slice(0, 6).join(", ")}{d.operations.length > 6 ? ", …" : ""}</span>}
                  </div>
                </div>
                <span className="spacer" />
                <button className="btn" onClick={() => setEditing(d.apiId)}>Edit</button>
                <button className="btn" onClick={() => void save({ dependencies: app.dependencies.filter((x) => x.apiId !== d.apiId) })}>Remove</button>
              </div>
            ),
          )}
          {editing === "new" && (
            <DependencyEditor apiOptions={(trackedApis ?? []).filter((a) => !app.dependencies.some((d) => d.apiId === a.id))} onSave={saveDependency} onCancel={() => setEditing(null)} />
          )}
          {trackedApis && trackedApis.length === 0 && (
            <p className="hint">Applications depend on tracked APIs. <button className="btn-link" onClick={() => navigate("apis")}>Track an API</button> first.</p>
          )}
        </div>
      </Panel>

      <NotificationSettings app={app} channels={channels ?? []} onSave={save} />

      <Panel title="Impact history" actions={<span className="muted small">changes to the APIs above that touch this application</span>}>
        <ImpactList impacts={impacts} empty="No changes have affected this application yet." />
      </Panel>

      <Panel title="Danger zone">
        <div className="pad toolbar">
          <span className="muted small">Deletes the application and its impact history. Channels and tracked APIs are kept.</span>
          <span className="spacer" />
          <button
            className="btn danger"
            onClick={async () => {
              if (window.confirm(`Delete ${app.name}?`)) {
                await api.deleteApplication(id);
                navigate("apps");
              }
            }}
          >
            Delete application
          </button>
        </div>
      </Panel>
    </div>
  );
}

function DependencyEditor({ apiOptions, initial, onSave, onCancel }: {
  apiOptions: { id: string; name: string }[];
  initial?: Dependency;
  onSave: (dep: Dependency) => Promise<void>;
  onCancel: () => void;
}) {
  const [apiId, setApiId] = useState(initial?.apiId ?? apiOptions[0]?.id ?? "");
  const [all, setAll] = useState(initial ? initial.operations === "all" : true);
  const [selected, setSelected] = useState<Set<string>>(new Set(initial && initial.operations !== "all" ? initial.operations : []));
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [filter, setFilter] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteResult, setPasteResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiId) return;
    setOperations(null);
    api.operations(apiId).then(setOperations, (e: Error) => setError(e.message));
  }, [apiId]);

  const visible = useMemo(
    () => (operations ?? []).filter((o) => !filter || `${o.key} ${o.summary ?? ""}`.toLowerCase().includes(filter.toLowerCase())),
    [operations, filter],
  );
  // Operations the app listed that the API no longer has (removed, or a typo).
  const unknown = [...selected].filter((k) => operations && !operations.some((o) => o.key === k));
  const toggle = (key: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <div className="dep-editor stack">
      <div className="row2">
        <label>
          Tracked API
          <select value={apiId} disabled={Boolean(initial)} onChange={(e) => (setApiId(e.target.value), setSelected(new Set()))}>
            {apiOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <div>
          <div className="label">Operations it calls</div>
          <div className="segmented" role="group">
            <button type="button" className={all ? "active" : ""} onClick={() => setAll(true)}>All</button>
            <button type="button" className={all ? "" : "active"} onClick={() => setAll(false)}>Specific operations</button>
          </div>
        </div>
      </div>
      {!all && (
        <>
          <div className="toolbar">
            <input type="search" placeholder="Filter operations" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="muted small">{selected.size} selected</span>
          </div>
          {operations === null ? <p className="muted">Loading operations…</p> : (
            <ul className="op-list">
              {visible.map((o) => (
                <li key={o.key}>
                  <label className="check">
                    <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggle(o.key)} />
                    <span className={`method method-${o.method.toLowerCase()}`}>{o.method}</span>
                    <span className="mono">{o.path}</span>
                    {o.summary && <span className="muted small">{o.summary}</span>}
                    {o.deprecated && <span className="pill">deprecated</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {unknown.length > 0 && (
            <p className="warn-box">
              Not in the API's current version (kept, so removals still count against this app): <span className="mono">{unknown.join(", ")}</span>
            </p>
          )}
          <details className="paste">
            <summary>Paste a list of operations</summary>
            <p className="hint">One per line, e.g. from your client code, an API gateway or access logs: <code>GET /pets/{"{id}"}</code>, <code>delete /pets/:id</code> or a full URL.</p>
            <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"GET /pets\nPOST /pets\nDELETE /pets/{id}"} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                const { keys, invalid } = parseOperationList(paste);
                setSelected((s) => new Set([...s, ...keys]));
                setPasteResult(`Added ${keys.length} operation${keys.length === 1 ? "" : "s"}${invalid.length ? `; skipped ${invalid.length} line(s) that aren't METHOD /path: ${invalid.slice(0, 3).join(" | ")}` : ""}.`);
                setPaste("");
              }}
            >
              Add from list
            </button>
            {pasteResult && <p className="hint">{pasteResult}</p>}
          </details>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={!apiId || busy || (!all && selected.size === 0)}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave({ apiId, operations: all ? "all" : [...selected] });
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function NotificationSettings({ app, channels, onSave }: { app: Application; channels: { id: string; name: string; type: string; enabled: boolean }[]; onSave: (patch: Partial<Application>) => Promise<void> }) {
  const [chosen, setChosen] = useState(new Set(app.channelIds));
  const [minSeverity, setMinSeverity] = useState<Severity>(app.minSeverity);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const dirty = minSeverity !== app.minSeverity || chosen.size !== app.channelIds.length || app.channelIds.some((c) => !chosen.has(c));
  return (
    <Panel title="Notifications">
      <div className="pad stack">
        {channels.length === 0 ? (
          <p className="muted">No channels yet. <button className="btn-link" onClick={() => navigate("channels")}>Add a Slack, Teams, webhook or pipeline channel</button> to get notified.</p>
        ) : (
          <ul className="op-list">
            {channels.map((c) => (
              <li key={c.id}>
                <label className="check">
                  <input type="checkbox" checked={chosen.has(c.id)} onChange={() => setChosen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
                  <span className="strong">{c.name}</span>
                  <span className="pill">{c.type}</span>
                  {!c.enabled && <span className="muted small">(disabled)</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <label>
          Notify for
          <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity)}>
            {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <div className="form-actions">
          {state === "saved" && !dirty && <span className="muted small">Saved</span>}
          <button
            className="btn primary"
            disabled={!dirty || state === "saving"}
            onClick={async () => {
              setState("saving");
              try {
                await onSave({ channelIds: [...chosen], minSeverity });
                setState("saved");
              } catch {
                setState("idle");
              }
            }}
          >
            Save notifications
          </button>
        </div>
      </div>
    </Panel>
  );
}
