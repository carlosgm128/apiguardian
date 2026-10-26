// Mirrors backend/src/apps/impact.ts operationKey (backend code can't be bundled):
// "GET /pets/{petId}" or "get /pets/:id" -> "GET /pets/{}".
const METHODS = new Set(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"]);

export function operationKey(input: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(input);
  if (!m) return null;
  const method = m[1]!.toUpperCase();
  if (!METHODS.has(method)) return null;
  let path = m[2]!;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.split("?")[0]!.replace(/\{[^}]*\}/g, "{}").replace(/\/:[^/]+/g, "/{}");
  return `${method} ${path.startsWith("/") ? path : `/${path}`}`;
}

export function parseOperationList(text: string): { keys: string[]; invalid: string[] } {
  const keys = new Set<string>();
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const key = operationKey(line);
    if (key) keys.add(key);
    else invalid.push(line);
  }
  return { keys: [...keys], invalid };
}
