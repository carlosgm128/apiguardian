import { useState, type FormEvent } from "react";
import { api, type ChannelInput } from "../api";
import { HeadersEditor, headersFromRows, type HeaderRow } from "../components/ApiForms";
import { Empty, Panel, StatusBadge } from "../components/ui";
import { usePoll } from "../hooks/hooks";
import { ago, secs } from "../lib/format";
import type { Channel, ChannelType } from "../types";

const REDACTED = "••••••";

/** What each channel type needs, and where to get it. */
const TYPES: Record<ChannelType, { label: string; urlLabel: string; placeholder: string; help: string }> = {
  slack: {
    label: "Slack",
    urlLabel: "Incoming webhook URL",
    placeholder: "https://hooks.slack.com/services/T000/B000/XXXX",
    help: "In Slack: create an app → Incoming Webhooks → Add New Webhook to Workspace, and pick the channel.",
  },
  teams: {
    label: "Microsoft Teams",
    urlLabel: "Workflow webhook URL",
    placeholder: "https://prod-00.westus.logic.azure.com/workflows/…",
    help: 'In Teams: channel → ⋯ → Workflows → "Post to a channel when a webhook request is received", then copy its URL. Messages are Adaptive Cards.',
  },
  discord: {
    label: "Discord",
    urlLabel: "Webhook URL",
    placeholder: "https://discord.com/api/webhooks/…",
    help: "In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy URL. Mentions are disabled in messages.",
  },
  webhook: {
    label: "Webhook",
    urlLabel: "Receiver URL",
    placeholder: "https://example.com/hooks/apiguardian",
    help: "Receives a JSON POST (event, application, API, versions, counts, changes, risks, report link). With a secret, each request carries X-Apiguardian-Signature: sha256=HMAC(secret, body).",
  },
  github: {
    label: "GitHub Actions",
    urlLabel: "Dispatch URL",
    placeholder: "https://api.github.com/repos/OWNER/REPO/dispatches",
    help: "Sends repository_dispatch. Start a workflow with `on: repository_dispatch: types: [apiguardian-api-change]`; the impact is in github.event.client_payload. Token: a fine-grained PAT with Contents read & write on that repo.",
  },
  gitlab: {
    label: "GitLab CI",
    urlLabel: "Pipeline trigger URL",
    placeholder: "https://gitlab.com/api/v4/projects/PROJECT_ID/trigger/pipeline",
    help: "Starts a pipeline with APIGUARDIAN_* variables (APP, API, SEVERITY, BREAKING, REPORT_URL, PAYLOAD). Token: Settings → CI/CD → Pipeline trigger tokens.",
  },
};

export function ChannelsPage() {
  const { data: channels, error, refresh } = usePoll(api.channels, 0);
  const { data: deliveries, refresh: refreshDeliveries } = usePoll(api.deliveries, 10_000);
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const test = async (c: Channel) => {
    setTesting(c.id);
    setMessage(null);
    try {
      const d = await api.testChannel(c.id);
      setMessage(d.ok ? `Test message delivered to ${c.name} (HTTP ${d.status}).` : `Test to ${c.name} failed: ${d.error}`);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setTesting(null);
      void refreshDeliveries();
    }
  };

  return (
    <div className="stack-lg">
      <Panel title="Notification channels" actions={editing === null && <button className="btn primary" onClick={() => setEditing("new")}>Add channel</button>}>
        {editing && <ChannelForm initial={editing === "new" ? undefined : editing} onDone={() => (setEditing(null), void refresh())} />}
        {error && <p className="error pad">{error}</p>}
        {message && <p className="pad small">{message}</p>}
        {channels && channels.length === 0 && !editing && (
          <Empty>No channels yet. Add Slack, Teams, Discord, a webhook, or a GitHub/GitLab pipeline, then attach it to applications.</Empty>
        )}
        {channels && channels.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Status</th><th>Channel</th><th>Type</th><th>Destination</th><th /></tr></thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td><StatusBadge status={c.enabled ? "done" : "skipped"} label={c.enabled ? "On" : "Off"} /></td>
                    <td className="strong">{c.name}</td>
                    <td>{TYPES[c.type].label}</td>
                    <td className="mono small muted">{c.url}</td>
                    <td className="row-actions">
                      <button className="btn" disabled={testing !== null} onClick={() => void test(c)}>{testing === c.id ? "Sending…" : "Send test"}</button>
                      <button className="btn" onClick={() => setEditing(c)}>Edit</button>
                      <button className="btn" onClick={async () => { await api.updateChannel(c.id, { enabled: !c.enabled }); void refresh(); }}>{c.enabled ? "Disable" : "Enable"}</button>
                      <button className="btn danger" onClick={async () => { if (window.confirm(`Delete channel ${c.name}? Applications using it stop notifying there.`)) { await api.deleteChannel(c.id); void refresh(); } }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent deliveries" actions={<span className="muted small">latest 200</span>}>
        {!deliveries || deliveries.length === 0 ? <Empty>Nothing sent yet.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Channel</th><th>Kind</th><th>Result</th><th className="num">HTTP</th><th className="num">Attempts</th><th className="num">Took</th><th>Error</th></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td title={d.at}>{ago(d.at)}</td>
                    <td>{d.channelName} <span className="muted small">({TYPES[d.channelType]?.label ?? d.channelType})</span></td>
                    <td>{d.test ? "test" : "impact"}</td>
                    <td><StatusBadge status={d.ok ? "done" : "failed"} label={d.ok ? "Delivered" : "Failed"} /></td>
                    <td className="num">{d.status ?? "–"}</td>
                    <td className="num">{d.attempts}</td>
                    <td className="num">{secs(d.durationMs)}</td>
                    <td className="wrap error small">{d.error}</td>
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

function ChannelForm({ initial, onDone }: { initial?: Channel; onDone: () => void }) {
  const [type, setType] = useState<ChannelType>(initial?.type ?? "slack");
  const [name, setName] = useState(initial?.name ?? "");
  // Stored URLs come back redacted; an untouched field keeps the stored value.
  const [url, setUrl] = useState(initial ? REDACTED : "");
  const [secret, setSecret] = useState(initial?.secret ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [ref, setRef] = useState(initial?.ref ?? "main");
  const [eventType, setEventType] = useState(initial?.eventType ?? "apiguardian-api-change");
  const [headers, setHeaders] = useState<HeaderRow[]>(Object.entries(initial?.headers ?? {}).map(([n, v]) => ({ name: n, value: v })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = TYPES[type];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: ChannelInput = {
      name,
      type,
      url,
      ...(type === "webhook" && { secret: secret || undefined, headers: headersFromRows(headers) }),
      ...((type === "github" || type === "gitlab") && { token }),
      ...(type === "gitlab" && { ref }),
      ...(type === "github" && { eventType }),
    };
    try {
      if (initial) await api.updateChannel(initial.id, input);
      else await api.createChannel(input);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="row2">
        <label>
          Type
          <select value={type} disabled={Boolean(initial)} onChange={(e) => setType(e.target.value as ChannelType)}>
            {(Object.keys(TYPES) as ChannelType[]).map((k) => <option key={k} value={k}>{TYPES[k].label}</option>)}
          </select>
        </label>
        <label>Name<input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. #payments-alerts" /></label>
      </div>
      <label>
        {t.urlLabel}
        <input type={initial && url === REDACTED ? "password" : "url"} required value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.placeholder} onFocus={() => url === REDACTED && setUrl("")} onBlur={() => initial && url === "" && setUrl(REDACTED)} />
      </label>
      <p className="hint">{t.help}</p>
      {type === "webhook" && (
        <>
          <label>Signing secret (optional)<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></label>
          <div>
            <div className="label">Extra headers (optional)</div>
            <HeadersEditor rows={headers} onChange={setHeaders} />
          </div>
        </>
      )}
      {(type === "github" || type === "gitlab") && (
        <label>{type === "github" ? "Token" : "Trigger token"}<input type="password" required value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
      )}
      {type === "gitlab" && <label>Branch or tag<input type="text" value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
      {type === "github" && <label>Event type<input type="text" value={eventType} onChange={(e) => setEventType(e.target.value)} /></label>}
      <p className="hint">URLs, secrets and tokens are stored in a file only you can read and are never shown again.</p>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : initial ? "Save channel" : "Add channel"}</button>
      </div>
    </form>
  );
}
