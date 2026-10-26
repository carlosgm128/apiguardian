import { useState } from "react";
import { api } from "../api";
import { CallDetail, LeadDetail, UnitDetail } from "../components/Details";
import { Timeline } from "../components/Timeline";
import { ChangesView, EventsView, InferenceView, RisksView, WorkersView } from "../components/Views";
import { Empty, Panel, StatTiles, StatusBadge, Tabs } from "../components/ui";
import { navigate, useNow, usePoll, useRunStream } from "../hooks/hooks";
import { RerunPanel } from "../components/RerunPanel";
import { RunSummary } from "../components/RunSummary";
import { agentsLabel, secs, tok, usd } from "../lib/format";
import { phase, totals } from "../state/runState";
import type { LlmCall } from "../types";

const TABS = ["overview", "workers", "inference", "changes", "risks", "events"] as const;
type Tab = (typeof TABS)[number];

/** Route: #/runs/:id/:tab/:item, where item is a unit id (overview, workers) or an LLM call seq (inference). */
export function RunPage({ runId, tab: rawTab, item }: { runId: string; tab?: string; item?: string }) {
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "overview";
  const { state, connection } = useRunStream(runId);
  const running = Boolean(state.start && !state.end);
  const { data: meta, error, refresh } = usePoll(() => api.run(runId), running ? 2000 : 0, [runId, running]);
  const now = useNow(running);
  const [cancelling, setCancelling] = useState(false);
  const [rerun, setRerun] = useState<null | "lead" | "failed" | "all" | "auto">(null);
  const selectedUnit = (tab === "overview" || tab === "workers") && item ? item : null;
  const openCall = tab === "inference" && item ? state.calls.find((c) => String(c.seq) === item) ?? null : null;
  const setOpenCall = (call: LlmCall | null) => (call ? navigate("runs", runId, "inference", String(call.seq)) : navigate("runs", runId, "inference"));
  const setSelectedUnit = (id: string | null) => {
    const target = tab === "workers" ? "workers" : "overview";
    if (id) navigate("runs", runId, target, id);
    else navigate("runs", runId, target);
  };

  if (error && !meta) return <Panel title="Run"><Empty>{error}</Empty></Panel>;

  const t = totals(state);
  const p = phase(state);
  const t0 = state.t0 ?? now;
  const elapsed = state.start ? (state.end?.t ?? now) - t0 : 0;
  const setTab = (next: Tab) => navigate("runs", runId, next);
  const selectUnit = (id: string) => setSelectedUnit(id || null);
  const openCallDetail = (call: LlmCall) => setOpenCall(call);
  const unit = selectedUnit ? state.units.get(selectedUnit) : undefined;

  const tiles = [
    { label: "Units", value: t.units },
    { label: "Breaking", value: t.breaking, sub: `${t.warnings} warn` },
    { label: "Queued", value: t.byStatus.queued },
    { label: "Running", value: t.byStatus.running, sub: state.start?.agents ? `of ${state.start.concurrency} slots` : "" },
    { label: "Done", value: t.byStatus.done },
    { label: "Failed", value: t.byStatus.failed },
    { label: "Follow-ups", value: t.followUps },
    { label: "LLM calls", value: t.calls, sub: t.llmMs ? `${secs(t.llmMs)} in calls` : "" },
    { label: "Tokens in", value: tok(t.inputTokens), sub: t.cacheReadTokens ? `${tok(t.cacheReadTokens)} cached` : "" },
    { label: "Tokens out", value: tok(t.outputTokens) },
    { label: "Est. cost", value: usd(t.cost) },
  ];

  const side =
    tab === "inference" ? (
      openCall ? <Panel title="LLM call" actions={<button className="btn-link" onClick={() => setOpenCall(null)}>Close</button>} className="side"><div className="pad"><CallDetail call={openCall} t0={t0} /></div></Panel>
      : <Panel title="LLM call" className="side"><Empty>Select a call to see its prompt and output.</Empty></Panel>
    ) : tab === "overview" || tab === "workers" ? (
      unit ? (
        <Panel title="Unit" actions={<button className="btn-link" onClick={() => setSelectedUnit(null)}>Show lead agent</button>} className="side">
          <div className="pad"><UnitDetail u={unit} state={state} onOpenCall={openCallDetail} /></div>
        </Panel>
      ) : (
        <Panel title="Lead agent" className="side"><div className="pad"><LeadDetail lead={state.lead} state={state} now={now} onOpenCall={openCallDetail} /></div></Panel>
      )
    ) : null;

  return (
    <div className="stack-lg">
      <header className="run-head">
        <div className="run-title">
          <button className="btn-link" onClick={() => navigate()}>← Runs</button>
          <h1 className="mono">{meta ? `${meta.baselineName} → ${meta.candidateName}` : runId}</h1>
        </div>
        <div className="run-meta">
          <StatusBadge status={p.tone === "idle" ? "queued" : p.tone} label={p.label} />
          {meta && !state.start?.simulated && <span className="pill">{agentsLabel(meta.config)}</span>}
          {meta?.retryOf && <button className="pill pill-link" onClick={() => navigate("runs", meta.retryOf!)}>Rerun of {meta.retryOf}{meta.retryScope === "lead" ? " (lead only)" : meta.retryScope === "failed" ? " (failed workers + lead)" : ""}</button>}
          {meta?.retriedBy?.length ? <button className="pill pill-link" onClick={() => navigate("runs", meta.retriedBy!.at(-1)!)}>Rerun as {meta.retriedBy.at(-1)}</button> : null}
          {meta?.origin && (
            <button className="pill pill-link" onClick={() => navigate("apis", meta.origin!.apiId)}>
              Tracked API: {meta.origin.apiName} #{Number(meta.origin.fromSnapshot.split("-")[0])} → #{Number(meta.origin.toSnapshot.split("-")[0])}
            </button>
          )}
          {meta?.config.workerEndpoints?.length ? <span className="pill mono">workers: {meta.config.workerEndpoints.join(", ")}</span> : null}
          {meta?.config.leadEndpoint ? <span className="pill mono">lead: {meta.config.leadEndpoint}</span> : null}
          {state.start?.simulated && <span className="pill pill-warn">Simulated: no model calls</span>}
          <span className="pill mono">{secs(elapsed)}</span>
          {state.start?.baselineVersion && <span className="pill mono">v{state.start.baselineVersion} → v{state.start.candidateVersion}</span>}
          <span className="muted small">{connection === "live" ? (running ? "live" : "loaded") : connection}</span>
          <span className="spacer" />
          {running && (meta?.source === "dashboard" || meta?.source === "tracker") && (
            <button className="btn danger" disabled={cancelling} onClick={async () => { setCancelling(true); await api.cancel(runId).catch(() => {}); void refresh(); }}>
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          )}
          {!running && (meta?.source === "dashboard" || meta?.source === "tracker") && state.end && (
            <>
              <button className="btn" onClick={() => setRerun("auto")}>Retry</button>
              <a className="btn" href={api.reportMdUrl(runId)}>Download report.md</a>
            </>
          )}
        </div>
        {(state.end?.error || meta?.error) && (
          <p className="error">
            {state.end?.error ?? meta?.error}
            {!running && state.lead.status === "failed" && t.byStatus.done > 0 && (meta?.source === "dashboard" || meta?.source === "tracker") && (
              <> <button className="btn-link" onClick={() => setRerun("lead")}>Rerun just the lead with another model</button></>
            )}
          </p>
        )}
      </header>

      {rerun && meta && <RerunPanel meta={meta} initialScope={rerun === "auto" ? undefined : rerun} onClose={() => setRerun(null)} />}

      <StatTiles tiles={tiles} />

      <RunSummary runId={runId} state={state} onSelectUnit={selectUnit} />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "workers", label: "Workers", count: t.units },
          { id: "inference", label: "Inference", count: t.calls },
          { id: "changes", label: "Changes", count: t.breaking + t.warnings },
          { id: "risks", label: "Risks", count: state.lead.report?.risks.length },
          { id: "events", label: "Events", count: state.events.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {!state.start ? (
        <Panel><Empty>{connection === "reconnecting" ? "Can't reach the server." : "Waiting for the run to start…"}</Empty></Panel>
      ) : (
        <div className={side ? "with-side" : ""}>
          <div className="main-col">
            {tab === "overview" && (
              <Panel title="Timeline" actions={<span className="muted small">{state.start.agents ? `${t.byStatus.running} of ${state.start.concurrency} worker slots busy` : "deterministic diff only"}</span>}>
                <Timeline state={state} now={now} selected={selectedUnit} onSelect={selectUnit} />
              </Panel>
            )}
            {tab === "workers" && <Panel title="Workers"><div className="pad"><WorkersView state={state} onSelect={selectUnit} /></div></Panel>}
            {tab === "inference" && <Panel title="Inference"><div className="pad"><InferenceView state={state} onOpen={setOpenCall} openSeq={openCall?.seq ?? null} /></div></Panel>}
            {tab === "changes" && <Panel title="What changed and how"><div className="pad"><ChangesView state={state} onSelect={selectUnit} /></div></Panel>}
            {tab === "risks" && <Panel title="What could fail"><div className="pad"><RisksView state={state} onSelect={selectUnit} /></div></Panel>}
            {tab === "events" && <Panel title="Event log"><div className="pad"><EventsView state={state} /></div></Panel>}
          </div>
          {side}
        </div>
      )}
    </div>
  );
}
