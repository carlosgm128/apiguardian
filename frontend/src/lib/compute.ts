import type { EndpointStatus, GpuInfo } from "../types";

/** GPUs an endpoint is pinned to, e.g. ["GPU 1 · RTX 4090"]; empty when it isn't pinned. */
export function endpointGpus(endpoint: Pick<EndpointStatus, "gpus">, gpus: GpuInfo[]): string[] {
  if (!endpoint.gpus) return [];
  return endpoint.gpus.split(",").map((idx) => {
    const gpu = gpus.find((g) => String(g.index) === idx.trim());
    return gpu ? `GPU ${gpu.index} · ${gpu.name.replace(/^NVIDIA (GeForce )?/, "")}` : `GPU ${idx}`;
  });
}

export function endpointLabel(endpoint: Pick<EndpointStatus, "id" | "gpus">, gpus: GpuInfo[]): string {
  const names = endpointGpus(endpoint, gpus);
  return names.length ? `${endpoint.id} (${names.join(", ")})` : endpoint.id;
}

export const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
