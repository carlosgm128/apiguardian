import { useState, type FormEvent } from "react";
import { api, type StartRunRequest } from "../api";
import { Panel } from "../components/ui";
import { navigate, usePoll } from "../hooks/hooks";
import { endpointGpus, gb } from "../lib/compute";
import { MODEL_OPTIONS } from "../lib/pricing";

type Source = "sample" | "upload";
type Mode = StartRunRequest["mode"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type Provider = "claude" | "ollama";
type Role = "worker" | "lead";

export function NewRunPage() {
  const { data: status } = usePoll(api.status, 0);
  const [source, setSource] = useState<Source>("sample");
  const [sample, setSample] = useState("");
  const [baseline, setBaseline] = useState<File | null>(null);
  const [candidate, setCandidate] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("simulate");
  const [leadChoice, setLeadChoice] = useState<"same" | Provider>("same");
  const [concurrency, setConcurrency] = useState(4);
  const [skipInfo, setSkipInfo] = useState(false);
  const [models, setModels] = useState<Partial<Record<`${Role}:${Provider}`, string>>>({});
  const [workerEffort, setWorkerEffort] = useState("medium");
  const [leadEffort, setLeadEffort] = useState("high");
  const [failureRate, setFailureRate] = useState(0);
  /** null = all endpoints. */
  const [workerEps, setWorkerEps] = useState<string[] | null>(null);
  const [leadEp, setLeadEp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const chosenSample = sample || status?.samples[0]?.id || "";
  const ready = source === "sample" ? Boolean(chosenSample) : Boolean(baseline && candidate);
  const agents = mode === "claude" || mode === "ollama";
  const workerProvider: Provider = mode === "ollama" ? "ollama" : "claude";
  const leadProvider: Provider = leadChoice === "same" ? workerProvider : leadChoice;
  const ollama = status?.ollama;
  const endpoints = ollama?.endpoints ?? [];
  const gpus = status?.gpus.gpus ?? [];
  // Instances normally share one model store, so the first reachable one lists the models.
  const ollamaModels = endpoints.find((e) => e.reachable)?.models ?? [];
  const chosenWorkerEps = workerEps ?? endpoints.map((e) => e.id);
  const chosenLeadEp = leadEp || (workerProvider === "ollama" ? chosenWorkerEps[0] : endpoints[0]?.id) || "";

  /** Chosen model, or the default: Opus 5.5 on Claude; on Ollama the first installed model (tool-capable for the lead). */
  const modelFor = (role: Role, provider: Provider): string => {
    const chosen = models[`${role}:${provider}`];
    if (chosen) return chosen;
    if (provider === "claude") return "claude-opus-5-5";
    return (role === "lead" ? ollamaModels.find((m) => m.tools) : undefined)?.name ?? ollamaModels[0]?.name ?? "";
  };
  const setModel = (role: Role, provider: Provider, value: string) => setModels({ ...models, [`${role}:${provider}`]: value });
  const usesClaude = agents && (workerProvider === "claude" || leadProvider === "claude");
  const usesOllama = agents && (workerProvider === "ollama" || leadProvider === "ollama");
  const leadOllamaModel = ollamaModels.find((m) => m.name === modelFor("lead", "ollama"));
  const usedEps = endpoints.filter(
    (e) => (workerProvider === "ollama" && chosenWorkerEps.includes(e.id)) || (leadProvider === "ollama" && e.id === chosenLeadEp),
  );
  const unreachable = usedEps.filter((e) => !e.reachable);
  const placementOk = !usesOllama || workerProvider !== "ollama" || chosenWorkerEps.length > 0;
  const toggleWorkerEp = (id: string) =>
    setWorkerEps(chosenWorkerEps.includes(id) ? chosenWorkerEps.filter((x) => x !== id) : [...chosenWorkerEps, id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const req: StartRunRequest = { mode, concurrency, skipInfo };
      if (source === "sample") req.sample = chosenSample;
      else {
        req.baseline = { name: baseline!.name, content: await baseline!.text() };
        req.candidate = { name: candidate!.name, content: await candidate!.text() };
      }
      if (agents) {
        Object.assign(req, {
          leadProvider: leadProvider !== workerProvider ? leadProvider : undefined,
          workerModel: modelFor("worker", workerProvider) || undefined,
          leadModel: modelFor("lead", leadProvider) || undefined,
          workerEffort: workerProvider === "claude" ? workerEffort : undefined,
          leadEffort: leadProvider === "claude" ? leadEffort : undefined,
          workerEndpoints: workerProvider === "ollama" && workerEps ? chosenWorkerEps : undefined,
          leadEndpoint: leadProvider === "ollama" && chosenLeadEp ? chosenLeadEp : undefined,
        });
      }
      if (mode === "simulate") req.failureRate = failureRate;
      const run = await api.start(req);
      navigate("runs", run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const roleFields = (role: Role, provider: Provider) => (
    <>
      <label>
        {role === "worker" ? "Worker" : "Lead"} model ({provider === "claude" ? "Claude" : "Ollama"})
        <select value={modelFor(role, provider)} onChange={(e) => setModel(role, provider, e.target.value)}>
          {provider === "claude"
            ? MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)
            : ollamaModels.map((m) => <option key={m.name} value={m.name}>{m.name}{m.size ? ` · ${m.size}` : ""}{m.tools ? "" : " · no tools"}</option>)}
        </select>
      </label>
      {provider === "claude" ? (
        <label>
          {role === "worker" ? "Worker" : "Lead"} effort
          <select value={role === "worker" ? workerEffort : leadEffort} onChange={(e) => (role === "worker" ? setWorkerEffort : setLeadEffort)(e.target.value)}>
            {EFFORTS.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      ) : (
        <span className="hint">Local model: no API cost. Context window {ollama?.numCtx.toLocaleString()} tokens per request{ollama?.think ? ", thinking on" : ""}.</span>
      )}
    </>
  );

  return (
    <Panel title="New run" className="narrow">
      <form className="form" onSubmit={submit}>
        <fieldset>
          <legend>Documentation to compare</legend>
          <div className="segmented" role="group">
            <button type="button" className={source === "sample" ? "active" : ""} onClick={() => setSource("sample")}>Sample</button>
            <button type="button" className={source === "upload" ? "active" : ""} onClick={() => setSource("upload")}>Upload files</button>
          </div>
          {source === "sample" ? (
            <label>
              Sample pair
              <select value={chosenSample} onChange={(e) => setSample(e.target.value)}>
                {status?.samples.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          ) : (
            <div className="row2">
              <label>
                Baseline (old)
                <input type="file" accept=".md,.markdown,.yaml,.yml,.json" onChange={(e) => setBaseline(e.target.files?.[0] ?? null)} />
              </label>
              <label>
                Candidate (new)
                <input type="file" accept=".md,.markdown,.yaml,.yml,.json" onChange={(e) => setCandidate(e.target.files?.[0] ?? null)} />
              </label>
            </div>
          )}
          <p className="hint">Swagger 2.0 / OpenAPI 3.x (.yaml, .yml, .json) or Markdown (.md). Both files must use the same format.</p>
        </fieldset>

        <fieldset>
          <legend>Agents</legend>
          <div className="segmented" role="group">
            <button type="button" className={mode === "claude" ? "active" : ""} onClick={() => setMode("claude")}>Claude</button>
            <button type="button" className={mode === "ollama" ? "active" : ""} onClick={() => setMode("ollama")}>Ollama</button>
            <button type="button" className={mode === "simulate" ? "active" : ""} onClick={() => setMode("simulate")}>Simulated</button>
            <button type="button" className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")}>Diff only</button>
          </div>
          {agents && (
            <>
              <label>
                Lead agent runs on
                <select value={leadChoice} onChange={(e) => setLeadChoice(e.target.value as "same" | Provider)}>
                  <option value="same">Same as workers ({workerProvider === "claude" ? "Claude" : "Ollama"})</option>
                  <option value="claude">Claude</option>
                  <option value="ollama">Ollama</option>
                </select>
              </label>
              {usesClaude && status && !status.credentials && (
                <p className="warn-box">
                  No Claude API credentials found on the server. Set <code>ANTHROPIC_API_KEY</code> or run <code>ant auth login</code>, then restart <code>apiguardian serve</code>. The run will stop at the first Claude call otherwise.
                </p>
              )}
              {usesOllama && unreachable.length > 0 && (
                <p className="warn-box">
                  Not reachable: {unreachable.map((e) => <code key={e.id}>{e.id} ({e.url}) </code>)}. Start Ollama with <code>ollama serve</code>, or point the server at it with <code>apiguardian serve --ollama-url</code> / <code>--ollama-gpus</code>.
                </p>
              )}
              {usesOllama && unreachable.length === 0 && ollamaModels.length === 0 && (
                <p className="warn-box">No models installed in Ollama. Pull one, e.g. <code>ollama pull qwen3.5:4b</code>.</p>
              )}
              <div className="row2">
                {roleFields("worker", workerProvider)}
                {roleFields("lead", leadProvider)}
              </div>
              {leadProvider === "ollama" && leadOllamaModel && !leadOllamaModel.tools && (
                <p className="hint">This lead model can't call tools, so it writes the report in one step and can't send workers back with follow-up questions.</p>
              )}
              <p className="hint">
                Each changed endpoint or section is one worker call, plus a few lead turns.
                {usesClaude ? " Claude calls spend API credits." : ""}
                {usesOllama ? " Ollama handles parallel requests up to its OLLAMA_NUM_PARALLEL setting; extra workers wait." : ""}
              </p>
            </>
          )}
          {usesOllama && endpoints.length > 0 && (
            <div className="placement">
              <div className="placement-head">
                <strong>GPU placement</strong>
                <span className="hint">
                  {status?.gpus.available ? `${gpus.length} GPU${gpus.length === 1 ? "" : "s"} detected` : "No GPU info (nvidia-smi not found)"} · {endpoints.length} Ollama endpoint{endpoints.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="endpoint-list">
                {endpoints.map((ep) => {
                  const names = endpointGpus(ep, gpus);
                  const vram = ep.loaded.reduce((n, m) => n + m.vramMb, 0);
                  return (
                    <li key={ep.id} className={ep.reachable ? "" : "is-down"}>
                      {workerProvider === "ollama" ? (
                        <label className="check">
                          <input type="checkbox" checked={chosenWorkerEps.includes(ep.id)} onChange={() => toggleWorkerEp(ep.id)} />
                          <span className="mono strong">{ep.id}</span>
                        </label>
                      ) : (
                        <span className="mono strong">{ep.id}</span>
                      )}
                      <span className="muted small mono ellipsis" title={ep.url}>{ep.url.replace(/^https?:\/\//, "")}</span>
                      <span className="small">{names.length ? names.join(", ") : "not pinned to a GPU (Ollama decides)"}</span>
                      <span className="muted small">
                        {ep.reachable ? `${ep.loaded.length ? `${ep.loaded.map((m) => m.name).join(", ")} loaded · ${gb(vram)} VRAM` : "no model loaded"}` : "unreachable"}
                      </span>
                      {leadProvider === "ollama" && chosenLeadEp === ep.id && <span className="pill">lead</span>}
                    </li>
                  );
                })}
              </ul>
              {leadProvider === "ollama" && endpoints.length > 1 && (
                <label>
                  Lead agent endpoint (GPU)
                  <select value={chosenLeadEp} onChange={(e) => setLeadEp(e.target.value)}>
                    {endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.id}{endpointGpus(ep, gpus).length ? ` · ${endpointGpus(ep, gpus).join(", ")}` : ""}</option>)}
                  </select>
                </label>
              )}
              <p className="hint">
                {endpoints.length > 1
                  ? "Workers are spread over the checked endpoints, each call going to the least busy one. Putting the lead on its own GPU keeps it from waiting behind workers."
                  : <>To run agents on specific GPUs, start the server with one Ollama per GPU: <code>apiguardian serve --ollama-gpus 0,1</code>, or add your own instances with <code>--ollama-endpoint gpu1=http://127.0.0.1:11435@1</code>.</>}
              </p>
              {!placementOk && <p className="error">Pick at least one endpoint for the workers.</p>}
            </div>
          )}
          {mode === "simulate" && (
            <label>
              Simulated failure rate: {Math.round(failureRate * 100)}%
              <input type="range" min={0} max={0.8} step={0.05} value={failureRate} onChange={(e) => setFailureRate(Number(e.target.value))} />
              <span className="hint">Fake agents with realistic timing and token counts. No API calls.</span>
            </label>
          )}
          {mode === "diff" && <p className="hint">Only the deterministic diff runs: no agents, no findings or risk list.</p>}
        </fieldset>

        {mode !== "diff" && (
          <fieldset>
            <legend>Execution</legend>
            <div className="row2">
              <label>Concurrent workers<input type="number" min={1} max={32} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} /></label>
              <label className="check"><input type="checkbox" checked={skipInfo} onChange={(e) => setSkipInfo(e.target.checked)} />Skip info-only units (prose edits are always reviewed)</label>
            </div>
          </fieldset>
        )}

        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => navigate("runs")}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ready || !placementOk || submitting}>{submitting ? "Starting…" : "Start run"}</button>
        </div>
      </form>
    </Panel>
  );
}
