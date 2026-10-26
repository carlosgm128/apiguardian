import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Which code a server process is running, so the dashboard can tell when the
// code on disk has moved on (e.g. after a merge) and the server needs a
// restart. The dashboard's files are served fresh from disk, but the backend
// only loads its code at startup, so a long-running server can be older than
// the UI it serves.

/** The directory holding package.json, found from this module's location (src/ or dist/). */
export function packageRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

/** The git commit when run from a checkout; otherwise the newest backend file's mtime. */
export async function codeVersion(root = packageRoot()): Promise<string | undefined> {
  if (!root) return undefined;
  const commit = await new Promise<string | undefined>((resolve) => {
    execFile("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, timeout: 2000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
  if (commit) return commit;
  const newest = Math.max(await newestMtime(join(root, "dist")), await newestMtime(join(root, "backend", "src")));
  return newest > 0 ? `mtime-${Math.round(newest)}` : undefined;
}

async function newestMtime(dir: string, depth = 0): Promise<number> {
  if (depth > 4 || !existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(path, depth + 1));
    else if (/\.(js|ts)$/.test(entry.name)) newest = Math.max(newest, (await stat(path)).mtimeMs);
  }
  return newest;
}
