import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { isOpenApiDocument } from "../swagger/normalize.js";

// Fetching a live API's Swagger/OpenAPI document and reducing it to a
// canonical form, so the same API served as YAML or JSON, or with keys in a
// different order, hashes the same and isn't recorded as a new version.

export const MAX_SPEC_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Where specs usually live, tried in order when given a base URL. */
export const DISCOVERY_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/swagger.yaml",
  "/v3/api-docs",
  "/v2/api-docs",
  "/swagger/v1/swagger.json",
  "/api-docs",
  "/api/openapi.json",
  "/docs/openapi.json",
];

export class SpecFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchedSpec {
  url: string;
  status: number;
  /** Canonical JSON (sorted keys, 2-space indent). */
  canonical: string;
  hash: string;
  summary: SpecSummary;
}

export interface SpecSummary {
  title?: string;
  version?: string;
  /** "2.0" for Swagger, "3.x.y" for OpenAPI. */
  specVersion: string;
  operations: number;
  paths: number;
}

export async function fetchSpec(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<FetchedSpec> {
  const target = checkUrl(url);
  let res: Response;
  try {
    res = await fetch(target, {
      headers: { accept: "application/json, application/yaml;q=0.9, */*;q=0.5", ...headers },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : error.message) : String(error);
    throw new SpecFetchError(`Could not fetch ${url}: ${reason}`);
  }
  if (!res.ok) throw new SpecFetchError(`${url} answered ${res.status} ${res.statusText}`, res.status);

  const text = await readLimited(res, url);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      doc = parseYaml(text);
    } catch {
      throw new SpecFetchError(`${url} did not return JSON or YAML`, res.status);
    }
  }
  if (!isOpenApiDocument(doc)) throw new SpecFetchError(`${url} is not a Swagger/OpenAPI document (no "swagger" or "openapi" field)`, res.status);

  const canonical = canonicalJson(doc);
  return {
    url: res.url || url,
    status: res.status,
    canonical,
    hash: createHash("sha256").update(canonical).digest("hex"),
    summary: summarizeSpec(doc as Record<string, any>),
  };
}

/**
 * Accepts the spec URL itself or the API's base URL. Returns the first URL
 * that serves a Swagger/OpenAPI document.
 */
export async function discoverSpec(url: string, headers: Record<string, string> = {}): Promise<FetchedSpec> {
  const errors: string[] = [];
  try {
    return await fetchSpec(url, headers);
  } catch (error) {
    // A URL naming a spec file is taken literally: if it fails, say so
    // rather than quietly tracking some other document on the same host.
    if (/\.(json|ya?ml)$/i.test(new URL(checkUrl(url)).pathname)) throw error;
    errors.push((error as Error).message);
  }
  const base = new URL(checkUrl(url));
  const prefix = base.pathname.replace(/\/+$/, "");
  const candidates = DISCOVERY_PATHS.flatMap((p) => [`${base.origin}${prefix}${p}`, `${base.origin}${p}`]);
  for (const candidate of [...new Set(candidates)]) {
    if (candidate === url) continue;
    try {
      return await fetchSpec(candidate, headers);
    } catch {
      // keep looking
    }
  }
  throw new SpecFetchError(`No Swagger/OpenAPI document at ${url} or at common paths (${DISCOVERY_PATHS.join(", ")}). ${errors[0] ?? ""}`.trim());
}

/** JSON with object keys sorted recursively; array order is kept (it can be meaningful). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function summarizeSpec(doc: Record<string, any>): SpecSummary {
  const paths = Object.values<Record<string, unknown>>(doc.paths ?? {});
  return {
    title: doc.info?.title,
    version: doc.info?.version,
    specVersion: String(doc.openapi ?? doc.swagger),
    paths: paths.length,
    operations: paths.reduce((n, item) => n + METHODS.filter((m) => item && m in item).length, 0),
  };
}

function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SpecFetchError(`"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SpecFetchError(`Only http(s) URLs can be tracked, not ${parsed.protocol}`);
  return parsed.href;
}

async function readLimited(res: Response, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_SPEC_BYTES) throw new SpecFetchError(`${url} is larger than ${MAX_SPEC_BYTES / 1048576} MB`);
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SPEC_BYTES) {
      await reader.cancel();
      throw new SpecFetchError(`${url} is larger than ${MAX_SPEC_BYTES / 1048576} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
