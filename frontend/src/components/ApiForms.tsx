import type { ServerStatus } from "../api";
import { MODEL_OPTIONS } from "../lib/pricing";
import type { RunConfig } from "../types";

export const INTERVALS = [
  { minutes: 0, label: "Manual only" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
];

export function intervalLabel(minutes: number): string {
  return INTERVALS.find((i) => i.minutes === minutes)?.label ?? `Every ${minutes} min`;
}

export function IntervalSelect({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  const options = INTERVALS.some((i) => i.minutes === value) ? INTERVALS : [...INTERVALS, { minutes: value, label: `Every ${value} min` }];
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {options.map((i) => <option key={i.minutes} value={i.minutes}>{i.label}</option>)}
    </select>
  );
}

export type HeaderRow = { name: string; value: string };

/** Request headers sent when fetching the spec (e.g. Authorization). Stored values come back redacted. */
export function HeadersEditor({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const set = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="headers-editor">
      {rows.map((row, i) => (
        <div key={i} className="header-row">
          <input type="text" placeholder="Header (e.g. Authorization)" value={row.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Header name" />
          <input type="password" placeholder="Value" value={row.value} onChange={(e) => set(i, { value: e.target.value })} aria-label="Header value" autoComplete="off" />
          <button type="button" className="btn" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove header">Remove</button>
        </div>
      ))}
      <button type="button" className="btn-link" onClick={() => onChange([...rows, { name: "", value: "" }])}>+ Add header</button>
    </div>
  );
}

export const headersFromRows = (rows: HeaderRow[]) =>
  Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));

const MODES: { id: RunConfig["mode"]; label: string }[] = [
  { id: "diff", label: "Diff only" },
  { id: "ollama", label: "Ollama" },
  { id: "claude", label: "Claude" },
  { id: "simulate", label: "Simulated" },
];

type Provider = "claude" | "ollama";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Agents for the report written automatically when a new version is found:
 * provider and model for the workers, and for the lead (which can run on the
 * other provider, e.g. local Ollama workers with a Claude lead). Diff only is
 * the default so scheduled checks never spend credits by surprise.
 */
export function ReportAgentsPicker({ value, onChange, status }: { value: Partial<RunConfig>; onChange: (v: Partial<RunConfig>) => void; status?: ServerStatus }) {
  const mode = value.mode ?? "diff";
  const agents = mode === "claude" || mode === "ollama";
  const workerProvider: Provider = mode === "ollama" ? "ollama" : "claude";
  const leadProvider: Provider = value.leadProvider ?? workerProvider;
  const ollamaModels = status?.ollama.endpoints.find((e) => e.reachable)?.models ?? [];

  const modelsFor = (provider: Provider, current?: string) => {
    const list = provider === "claude"
      ? MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label }))
      : ollamaModels.map((m) => ({ id: m.name, label: `${m.name}${m.size ? ` · ${m.size}` : ""}${m.tools ? "" : " · no tools"}` }));
    // Keep a saved model selectable even if the server doesn't list it right now.
    return current && !list.some((m) => m.id === current) ? [{ id: current, label: `${current} (saved)` }, ...list] : list;
  };

  const setMode = (next: RunConfig["mode"]) => {
    const nextWorker: Provider = next === "ollama" ? "ollama" : "claude";
    const keepLead = value.leadProvider && value.leadProvider !== nextWorker;
    onChange({
      ...value,
      mode: next,
      workerModel: undefined,
      workerEffort: undefined,
      // A lead on its own provider keeps its settings; otherwise it follows the workers.
      leadProvider: keepLead ? value.leadProvider : undefined,
      leadModel: keepLead ? value.leadModel : undefined,
      leadEffort: keepLead ? value.leadEffort : undefined,
    });
  };

  const setLeadProvider = (choice: "same" | Provider) => {
    const provider = choice === "same" ? undefined : choice;
    onChange({ ...value, leadProvider: provider === workerProvider ? undefined : provider, leadModel: undefined, leadEffort: undefined });
  };

  const role = (which: "worker" | "lead", provider: Provider) => {
    const modelKey = which === "worker" ? "workerModel" : "leadModel";
    const effortKey = which === "worker" ? "workerEffort" : "leadEffort";
    return (
      <div className="role">
        <div className="strong small">{which === "worker" ? "Workers" : "Lead agent"} <span className="muted">({provider === "claude" ? "Claude" : "Ollama"})</span></div>
        <label>
          Model
          <select value={value[modelKey] ?? ""} onChange={(e) => onChange({ ...value, [modelKey]: e.target.value || undefined })}>
            <option value="">{provider === "claude" ? "Default (Claude Opus 5.5)" : which === "lead" ? "Default (first tool-capable model)" : "Default (first installed model)"}</option>
            {modelsFor(provider, value[modelKey]).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        {provider === "claude" && (
          <label>
            Effort
            <select value={value[effortKey] ?? ""} onChange={(e) => onChange({ ...value, [effortKey]: (e.target.value || undefined) as RunConfig["workerEffort"] })}>
              <option value="">Default ({which === "worker" ? "medium" : "high"})</option>
              {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        )}
      </div>
    );
  };

  return (
    <div className="stack">
      <div className="segmented" role="group" aria-label="Report agents">
        {MODES.map((m) => (
          <button type="button" key={m.id} className={mode === m.id ? "active" : ""} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {agents && (
        <>
          <label>
            Lead agent runs on
            <select value={value.leadProvider ?? "same"} onChange={(e) => setLeadProvider(e.target.value as "same" | Provider)}>
              <option value="same">Same as workers ({workerProvider === "claude" ? "Claude" : "Ollama"})</option>
              <option value="claude">Claude</option>
              <option value="ollama">Ollama</option>
            </select>
          </label>
          <div className="role-grid">
            {role("worker", workerProvider)}
            {role("lead", leadProvider)}
          </div>
        </>
      )}
      <p className="hint">
        {mode === "diff" && "Each new version gets the deterministic change list. No agents, no cost."}
        {agents && "Workers analyze each changed operation; the lead turns their findings into the risk list. A larger lead model helps when there are many changes."}
        {agents && (workerProvider === "claude" || leadProvider === "claude") && " Claude calls spend API credits on every detected change."}
        {mode === "simulate" && "Fake agent output, for trying the pipeline out."}
      </p>
    </div>
  );
}
