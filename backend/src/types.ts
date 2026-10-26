// Domain types shared by the differs, the agents and the report renderer.

export type DocFormat = "openapi" | "markdown";

/** Impact on a client written against the baseline docs. */
export type Severity = "breaking" | "warning" | "info";

/** A single difference found deterministically (no LLM involved). */
export interface Change {
  /** Stable within one run; agents reference changes by this id. */
  id: string;
  unitId: string;
  kind: string;
  /** Human-readable location, e.g. `GET /pets/{id} > response 200 > body.name`. */
  location: string;
  severity: Severity;
  message: string;
  before?: unknown;
  after?: unknown;
}

/**
 * One slice of the API handed to a single worker agent: an operation for
 * OpenAPI, a heading section for Markdown, or the spec-wide settings.
 */
export interface WorkUnit {
  id: string;
  format: DocFormat;
  title: string;
  status: "added" | "removed" | "modified";
  /** Excerpt from the baseline (old) docs; absent when the unit was added. */
  baseline?: string;
  /** Excerpt from the candidate (new) docs; absent when the unit was removed. */
  candidate?: string;
  changes: Change[];
  /** Line diff between the excerpts (Markdown units). */
  diff?: string;
}

export interface DiffResult {
  format: DocFormat;
  baselineVersion?: string;
  candidateVersion?: string;
  units: WorkUnit[];
}
