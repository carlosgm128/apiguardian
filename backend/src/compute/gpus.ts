import { execFile } from "node:child_process";

// GPU inventory for the dashboard's System page and placement pickers.
// NVIDIA only (nvidia-smi); other vendors show as "no GPU info".

export interface GpuInfo {
  index: number;
  uuid: string;
  name: string;
  memoryTotalMb: number;
  memoryUsedMb: number;
  utilizationPct: number | null;
  temperatureC: number | null;
}

export interface GpuReport {
  available: boolean;
  gpus: GpuInfo[];
  error?: string;
}

const QUERY = "index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu";

export function listGpus(command = "nvidia-smi"): Promise<GpuReport> {
  return new Promise((resolve) => {
    execFile(command, [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ available: false, gpus: [], error: missing ? `${command} not found` : error.message });
        return;
      }
      resolve({ available: true, gpus: parseNvidiaSmi(stdout) });
    });
  });
}

/** Parses `nvidia-smi --query-gpu=<QUERY> --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(csv: string): GpuInfo[] {
  const num = (v: string | undefined) => {
    const n = Number(v?.trim());
    return v === undefined || v.trim() === "" || Number.isNaN(n) ? null : n;
  };
  return csv
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, uuid, name, total, used, util, temp] = line.split(",").map((c) => c.trim());
      return {
        index: num(index) ?? 0,
        uuid: uuid ?? "",
        name: name ?? "GPU",
        memoryTotalMb: num(total) ?? 0,
        memoryUsedMb: num(used) ?? 0,
        // "[N/A]" on some boards
        utilizationPct: num(util),
        temperatureC: num(temp),
      };
    });
}
