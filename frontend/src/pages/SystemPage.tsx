import { api } from "../api";
import { Empty, Panel, StatusBadge } from "../components/ui";
import { usePoll } from "../hooks/hooks";
import { endpointGpus, gb } from "../lib/compute";
import type { GpuInfo } from "../types";

/** A labelled meter: the value is always printed, the bar only reinforces it. */
function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="muted small">{label}</span>
        <span className="small strong">{text}</span>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  return (
    <div className="gpu-card">
      <div className="gpu-title">
        <span className="mono strong">GPU {gpu.index}</span>
        <span>{gpu.name}</span>
      </div>
      <Meter label="Utilization" value={gpu.utilizationPct ?? 0} max={100} text={gpu.utilizationPct === null ? "n/a" : `${gpu.utilizationPct}%`} />
      <Meter label="Memory" value={gpu.memoryUsedMb} max={gpu.memoryTotalMb} text={`${gb(gpu.memoryUsedMb)} / ${gb(gpu.memoryTotalMb)}`} />
      <div className="muted small">{gpu.temperatureC !== null ? `${gpu.temperatureC} °C` : ""}</div>
    </div>
  );
}

export function SystemPage() {
  const { data, error } = usePoll(api.compute, 2000);
  const gpus = data?.gpus.gpus ?? [];

  return (
    <div className="stack-lg">
      <Panel title="GPUs" actions={<span className="muted small">refreshes every 2s</span>}>
        {error && <p className="error pad">{error}</p>}
        {data && !data.gpus.available && <Empty>No GPU info: {data.gpus.error}. Ollama may still run on CPU or on GPUs nvidia-smi can't see.</Empty>}
        {data?.gpus.available && <div className="gpu-grid pad">{gpus.map((g) => <GpuCard key={g.uuid || g.index} gpu={g} />)}</div>}
      </Panel>

      <Panel title="Ollama endpoints">
        {data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Status</th><th>Endpoint</th><th>GPU</th><th>Version</th><th>Loaded models</th><th className="num">VRAM</th></tr>
              </thead>
              <tbody>
                {data.endpoints.map((ep) => (
                  <tr key={ep.id}>
                    <td><StatusBadge status={ep.reachable ? "done" : "failed"} label={ep.reachable ? "Up" : "Down"} /></td>
                    <td>
                      <div className="mono strong">{ep.id}{ep.managed ? <span className="muted small"> · managed</span> : null}</div>
                      <div className="mono muted small">{ep.url}</div>
                    </td>
                    <td>{endpointGpus(ep, gpus).join(", ") || <span className="muted">not pinned</span>}</td>
                    <td className="mono">{ep.version ?? "–"}</td>
                    <td>{ep.loaded.length ? ep.loaded.map((m) => <div key={m.name} className="mono small">{m.name} <span className="muted">· {gb(m.vramMb)} of {gb(m.sizeMb)} on GPU</span></div>) : <span className="muted">none</span>}</td>
                    <td className="num">{gb(ep.loaded.reduce((n, m) => n + m.vramMb, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint pad">
          Each endpoint is one <code>ollama serve</code>. To pin agents to GPUs, run one per GPU: <code>apiguardian serve --ollama-gpus 0,1</code> starts and stops them for you, or register your own with <code>--ollama-endpoint id=url@gpu</code>.
        </p>
      </Panel>
    </div>
  );
}
