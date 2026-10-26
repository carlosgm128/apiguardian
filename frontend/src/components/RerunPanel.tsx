import { useEffect, useState } from "react";
import { api, type RetryInfo, type ServerStatus } from "../api";
import { navigate, usePoll } from "../hooks/hooks";
import { MODEL_OPTIONS } from "../lib/pricing";
import type { RunConfig, RunMeta } from "../types";
import { Panel } from "./ui";

type Scope = "lead" | "failed" | "all";
type Provider = "claude" | "ollama";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

interface RoleChoice {
  provider: Provider;
  model: string;
  effort: string;
}

/**
 * Rerun a finished run on the same documents: just the lead (reusing every
 * worker analysis), the failed workers plus the lead, or everything, with the
 * option to switch provider/model per role (a model that can't finish the
 * task, or a provider that's down).
 */
export function RerunPanel({ meta, initialScope, onClose }: { meta: RunMeta; initialScope?: Scope; onClose: () => void }) {
  const [info, setInfo] = useState<RetryInfo | null>(null);
  const { data: status } = usePoll(api.status, 0);
  const original = meta.config;
  const originalWorker: Provider = original.mode === "ollama" ? "ollama" : "claude";
  const originalLead: Provider = original.leadProvider ?? originalWorker;
  const [scope, setScope] = useState<Scope>(initialScope ?? "lead");
  const [worker, setWorker] = useState<RoleChoice>({ provider: originalWorker, model: original.workerModel ?? "", effort: original.workerEffort ?? "medium" });
  const [lead, setLead] = useState<RoleChoice>({ provider: originalLead, model: original.leadModel ?? "", effort: original.leadEffort ?? "high" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.retryInfo(meta.id).then((i) => {
      setInfo(i);
      // Nothing to reuse (e.g. a diff-only run, or every worker failed): only "everything" makes sense.
      if (i.analyses === 0) setScope("all");
      else if (!initialScope && i.failedUnits + i.notRunUnits > 0 && i.hasRiskReport) setScope("failed");
    }, (e: Error) =>
      setError(
        e.message === "Not found"
          ? "The server doesn't know about reruns: it's running older code than this dashboard. Restart it (stop `npm run serve` and start it again), then reload this page."
          : e.message,
      ));
  }, [meta.id, initialScope]);

  const canReuse = (info?.analyses ?? 0) > 0;
  const missing = (info?.failedUnits ?? 0) + (info?.notRunUnits ?? 0);
  const scopes: { id: Scope; title: string; detail: string; disabled: boolean }[] = [
    {
      id: "lead",
      title: "Only the lead agent",
      detail: canReuse
        ? `Reuse all ${info!.analyses} worker analyses and rerun just the synthesis.${missing ? ` ${missing} unit(s) without an analysis stay unreviewed.` : ""}`
        : "No worker analyses to reuse.",
      disabled: !canReuse,
    },
    {
      id: "failed",
      title: "Failed workers and the lead",
      detail: !canReuse ? "No worker analyses to reuse."
        : missing === 0 ? "No worker failed, so this is the same as rerunning only the lead."
        : `Reuse ${info!.analyses} analyses, rerun ${missing} worker(s) that failed or never ran, then the lead.`,
      disabled: !canReuse || missing === 0,
    },
    { id: "all", title: "Everything", detail: `Run all ${info?.units ?? "?"} workers and the lead again on the same documents.`, disabled: false },
  ];

  async function start() {
    setBusy(true);
    setError(null);
    const config: Partial<RunConfig> = {
      mode: worker.provider,
      leadProvider: lead.provider !== worker.provider ? lead.provider : undefined,
      workerModel: worker.model || undefined,
      leadModel: lead.model || undefined,
      workerEffort: worker.provider === "claude" ? (worker.effort as RunConfig["workerEffort"]) : undefined,
      leadEffort: lead.provider === "claude" ? (lead.effort as RunConfig["leadEffort"]) : undefined,
    };
    try {
      const run = await api.retry(meta.id, { scope, config });
      navigate("runs", run.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Panel title="Rerun" actions={<button className="btn-link" onClick={onClose}>Close</button>}>
      <div className="pad stack">
        {info?.leadError && (
          <p className="warn-box">
            <strong>The lead agent stopped:</strong> {info.leadError}
          </p>
        )}
        <fieldset className="scope-list">
          <legend className="sr-only">What to rerun</legend>
          {scopes.map((s) => (
            <label key={s.id} className={`scope${scope === s.id ? " selected" : ""}${s.disabled ? " disabled" : ""}`}>
              <input type="radio" name="scope" value={s.id} checked={scope === s.id} disabled={s.disabled} onChange={() => setScope(s.id)} />
              <span>
                <strong>{s.title}</strong>
                <span className="muted small"> {s.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="role-grid">
          <RolePicker title="Lead agent" choice={lead} onChange={setLead} status={status} original={roleLabel(originalLead, original.leadModel)} />
          <RolePicker
            title={scope === "lead" ? "Workers (only for the lead's follow-up questions)" : "Workers"}
            choice={worker}
            onChange={setWorker}
            status={status}
            original={roleLabel(originalWorker, original.workerModel)}
          />
        </div>
        <p className="hint">
          The rerun is a new run linked to this one; this run stays as it is. Reused analyses add no tokens or cost.
          {meta.origin && meta.origin.trigger !== "compare" && " For a tracked API, the rerun's report replaces this one in the version history and in applications' impacts, without notifying again."}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !info || !info.retryable} onClick={start}>{busy ? "Starting…" : "Start rerun"}</button>
        </div>
        {info && !info.retryable && <p className="hint">This run can't be rerun from here (runs from the CLI or a replay don't keep their inputs on the server).</p>}
      </div>
    </Panel>
  );
}

function roleLabel(provider: Provider, model?: string) {
  return `${provider === "claude" ? "Claude" : "Ollama"} · ${model ?? (provider === "claude" ? "claude-opus-5-5 (default)" : "first installed model")}`;
}

function RolePicker({ title, choice, onChange, status, original }: { title: string; choice: RoleChoice; onChange: (c: RoleChoice) => void; status?: ServerStatus; original: string }) {
  const ollamaModels = status?.ollama.endpoints.find((e) => e.reachable)?.models ?? [];
  const models = choice.provider === "claude" ? MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label })) : ollamaModels.map((m) => ({ id: m.name, label: `${m.name}${m.size ? ` · ${m.size}` : ""}${m.tools ? "" : " · no tools"}` }));
  // Keep a model the server doesn't list (e.g. the original run's) selectable.
  const options = choice.model && !models.some((m) => m.id === choice.model) ? [{ id: choice.model, label: `${choice.model} (original)` }, ...models] : models;
  return (
    <div className="role">
      <div className="strong small">{title}</div>
      <div className="muted small">Original: {original}</div>
      <div className="segmented" role="group" aria-label={`${title} provider`}>
        {(["claude", "ollama"] as const).map((p) => (
          <button type="button" key={p} className={choice.provider === p ? "active" : ""} onClick={() => onChange({ ...choice, provider: p, model: "" })}>
            {p === "claude" ? "Claude" : "Ollama"}
          </button>
        ))}
      </div>
      <label>
        Model
        <select value={choice.model} onChange={(e) => onChange({ ...choice, model: e.target.value })}>
          <option value="">{choice.provider === "claude" ? "Default (Claude Opus 5.5)" : "Default (first installed model)"}</option>
          {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      {choice.provider === "claude" && (
        <label>
          Effort
          <select value={choice.effort} onChange={(e) => onChange({ ...choice, effort: e.target.value })}>
            {EFFORTS.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      )}
      {choice.provider === "claude" && status && !status.credentials && <p className="warn-box small">No Claude credentials on the server: this would stop at the first call.</p>}
      {choice.provider === "ollama" && status && !status.ollama.endpoints.some((e) => e.reachable) && <p className="warn-box small">Ollama isn't reachable from the server.</p>}
    </div>
  );
}
