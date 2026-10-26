import type { Change, DiffResult, Severity, WorkUnit } from "../types.js";
import {
  CONSTRAINT_KEYS,
  type ConstraintKey,
  type NBody,
  type NOperation,
  type NParameter,
  type NSchema,
  type NSpec,
} from "./normalize.js";

// Severity is judged from the point of view of a client written against the
// baseline. "request" schemas are what the client sends; "response" schemas
// are what it parses. Tightening a request or loosening a response breaks it.

type Direction = "request" | "response";

export const GLOBAL_UNIT_ID = "spec:global";

class ChangeCollector {
  readonly changes: Change[] = [];
  constructor(readonly unitId: string) {}

  add(kind: string, location: string, severity: Severity, message: string, before?: unknown, after?: unknown) {
    this.changes.push({
      id: `${this.unitId}#${this.changes.length + 1}`,
      unitId: this.unitId,
      kind,
      location,
      severity,
      message,
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
    });
  }
}

export function diffOpenApi(baseline: NSpec, candidate: NSpec): DiffResult {
  const units: WorkUnit[] = [];

  const global = diffGlobal(baseline, candidate);
  if (global.changes.length > 0) {
    units.push({
      id: GLOBAL_UNIT_ID,
      format: "openapi",
      title: "Spec-wide settings (servers, security schemes, version)",
      status: "modified",
      baseline: json({ version: baseline.version, servers: baseline.servers, securitySchemes: baseline.securitySchemes }),
      candidate: json({ version: candidate.version, servers: candidate.servers, securitySchemes: candidate.securitySchemes }),
      changes: global.changes,
    });
  }

  const keys = [...new Set([...Object.keys(baseline.operations), ...Object.keys(candidate.operations)])].sort();
  for (const key of keys) {
    const before = baseline.operations[key];
    const after = candidate.operations[key];
    const c = new ChangeCollector(key);

    if (before && !after) {
      c.add("operation-removed", key, before.deprecated ? "warning" : "breaking",
        before.deprecated ? "Deprecated operation was removed" : "Operation was removed");
    } else if (!before && after) {
      c.add("operation-added", key, "info", "Operation was added");
    } else if (before && after) {
      diffOperation(before, after, c);
    }
    if (c.changes.length === 0) continue;

    units.push({
      id: key,
      format: "openapi",
      title: `${(after ?? before)!.method} ${(after ?? before)!.path}`,
      status: !before ? "added" : !after ? "removed" : "modified",
      baseline: before && json(before),
      candidate: after && json(after),
      changes: c.changes,
    });
  }

  return { format: "openapi", baselineVersion: baseline.version, candidateVersion: candidate.version, units };
}

function diffGlobal(baseline: NSpec, candidate: NSpec): ChangeCollector {
  const c = new ChangeCollector(GLOBAL_UNIT_ID);
  if (baseline.version !== candidate.version) {
    c.add("version-changed", "info.version", "info", "Documented API version changed", baseline.version, candidate.version);
  }
  for (const url of baseline.servers.filter((s) => !candidate.servers.includes(s))) {
    c.add("server-removed", "servers", "breaking", `Server ${url} is no longer documented`, url);
  }
  for (const url of candidate.servers.filter((s) => !baseline.servers.includes(s))) {
    c.add("server-added", "servers", "info", `Server ${url} was added`, undefined, url);
  }
  const names = new Set([...Object.keys(baseline.securitySchemes), ...Object.keys(candidate.securitySchemes)]);
  for (const name of [...names].sort()) {
    const b = baseline.securitySchemes[name];
    const a = candidate.securitySchemes[name];
    if (b && !a) c.add("security-scheme-removed", `securitySchemes.${name}`, "breaking", `Security scheme ${name} was removed`, b);
    else if (!b && a) c.add("security-scheme-added", `securitySchemes.${name}`, "info", `Security scheme ${name} was added`, undefined, a);
    else if (json(b) !== json(a)) c.add("security-scheme-changed", `securitySchemes.${name}`, "breaking", `Security scheme ${name} changed`, b, a);
  }
  return c;
}

function diffOperation(before: NOperation, after: NOperation, c: ChangeCollector) {
  const loc = before.key;

  if (before.path !== after.path) {
    c.add("path-template-changed", loc, "info", "Path parameter names changed (same URL shape)", before.path, after.path);
  }
  if (before.operationId !== after.operationId) {
    c.add("operation-id-changed", loc, "warning",
      "operationId changed; generated client method names will change", before.operationId, after.operationId);
  }
  if (!before.deprecated && after.deprecated) {
    c.add("operation-deprecated", loc, "warning", "Operation is now deprecated");
  } else if (before.deprecated && !after.deprecated) {
    c.add("operation-undeprecated", loc, "info", "Operation is no longer deprecated");
  }
  for (const field of ["summary", "description"] as const) {
    if ((before[field] ?? "") !== (after[field] ?? "")) {
      c.add("description-changed", `${loc} > ${field}`, "info",
        `Operation ${field} text changed; check for semantic changes`, before[field], after[field]);
    }
  }

  diffSecurity(before.security, after.security, loc, c);
  diffParameters(before.parameters, after.parameters, loc, c);
  diffRequestBody(before.requestBody, after.requestBody, loc, c);
  diffResponses(before, after, loc, c);
}

function diffSecurity(before: string[], after: string[], loc: string, c: ChangeCollector) {
  const removed = before.filter((s) => !after.includes(s));
  const added = after.filter((s) => !before.includes(s));
  if (removed.length === 0 && added.length === 0) return;

  const authless = (list: string[]) => list.length === 0 || list.includes("(none)");
  if (authless(before) && !authless(after)) {
    c.add("security-required", `${loc} > security`, "breaking", "Authentication is now required", before, after);
  } else if (!authless(before) && authless(after)) {
    c.add("security-relaxed", `${loc} > security`, "warning", "Authentication is no longer required", before, after);
  } else if (removed.length > 0) {
    c.add("security-changed", `${loc} > security`, "breaking",
      `Accepted authentication options removed: ${removed.join(", ")}`, before, after);
  } else {
    c.add("security-changed", `${loc} > security`, "info",
      `New authentication options accepted: ${added.join(", ")}`, before, after);
  }
}

function diffParameters(before: Record<string, NParameter>, after: Record<string, NParameter>, loc: string, c: ChangeCollector) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    const where = `${loc} > ${(a ?? b)!.in} parameter "${(a ?? b)!.name}"`;

    if (b && !a) {
      c.add("parameter-removed", where, "warning", "Parameter is no longer documented; requests that send it may be rejected or it may be ignored");
      continue;
    }
    if (!b && a) {
      c.add("parameter-added", where, a.required ? "breaking" : "info",
        a.required ? "New required parameter" : "New optional parameter");
      continue;
    }
    if (!b || !a) continue;

    if (b.in === "path" && b.name !== a.name) {
      c.add("parameter-renamed", where, "info", "Path parameter renamed", b.name, a.name);
    }
    if (!b.required && a.required) c.add("parameter-required", where, "breaking", "Parameter became required");
    if (b.required && !a.required) c.add("parameter-optional", where, "info", "Parameter became optional");
    if (!b.deprecated && a.deprecated) c.add("parameter-deprecated", where, "warning", "Parameter is now deprecated");
    if ((b.description ?? "") !== (a.description ?? "")) {
      c.add("description-changed", where, "info", "Parameter description changed; check for semantic changes", b.description, a.description);
    }
    diffSchema(b.schema, a.schema, "request", where, c);
  }
}

function diffRequestBody(before: NBody | undefined, after: NBody | undefined, loc: string, c: ChangeCollector) {
  const where = `${loc} > request body`;
  if (!before && !after) return;
  if (before && !after) {
    c.add("request-body-removed", where, "warning", "Request body is no longer documented");
    return;
  }
  if (!before && after) {
    c.add("request-body-added", where, after.required ? "breaking" : "info",
      after.required ? "A request body is now required" : "An optional request body was added");
    return;
  }
  const b = before!;
  const a = after!;
  if (!b.required && a.required) c.add("request-body-required", where, "breaking", "Request body became required");
  for (const ct of b.contentTypes.filter((t) => !a.contentTypes.includes(t))) {
    c.add("request-content-type-removed", where, "breaking", `Content type ${ct} is no longer accepted`);
  }
  for (const ct of a.contentTypes.filter((t) => !b.contentTypes.includes(t))) {
    c.add("request-content-type-added", where, "info", `Content type ${ct} is now accepted`);
  }
  if (b.schema && a.schema) diffSchema(b.schema, a.schema, "request", where, c);
}

function diffResponses(before: NOperation, after: NOperation, loc: string, c: ChangeCollector) {
  const statuses = [...new Set([...Object.keys(before.responses), ...Object.keys(after.responses)])].sort();
  for (const status of statuses) {
    const b = before.responses[status];
    const a = after.responses[status];
    const where = `${loc} > response ${status}`;
    const success = status.startsWith("2");

    if (b && !a) {
      c.add("response-removed", where, success ? "breaking" : "warning",
        success ? `Success response ${status} is no longer returned` : `Response ${status} is no longer documented`);
      continue;
    }
    if (!b && a) {
      c.add("response-added", where, success ? "warning" : "info",
        success ? `New success status ${status}; clients checking for the old status may misread it` : `New documented response ${status}`);
      continue;
    }
    if (!b || !a) continue;

    if ((b.description ?? "") !== (a.description ?? "")) {
      c.add("description-changed", where, "info", "Response description changed; check for semantic changes", b.description, a.description);
    }
    for (const ct of b.contentTypes.filter((t) => !a.contentTypes.includes(t))) {
      c.add("response-content-type-removed", where, "warning", `Response no longer offered as ${ct}`);
    }
    if (b.schema && !a.schema) c.add("response-body-removed", where, "breaking", "Response body is no longer documented");
    else if (!b.schema && a.schema) c.add("response-body-added", where, "info", "Response now has a documented body");
    else if (b.schema && a.schema) diffSchema(b.schema, a.schema, "response", `${where} > body`, c);
  }
}

const sev = (dir: Direction, ifRequest: Severity, ifResponse: Severity): Severity =>
  dir === "request" ? ifRequest : ifResponse;

function diffSchema(b: NSchema, a: NSchema, dir: Direction, where: string, c: ChangeCollector) {
  if (b.circular || a.circular) {
    if (b.circular !== a.circular) c.add("schema-changed", where, "warning", "Recursive schema reference changed", b.circular, a.circular);
    return;
  }

  if ((b.type ?? "") !== (a.type ?? "") && b.type && a.type) {
    c.add("type-changed", where, "breaking", `Type changed from ${b.type} to ${a.type}`, b.type, a.type);
    return; // children of a different type are not comparable
  }
  if ((b.format ?? "") !== (a.format ?? "")) {
    c.add("format-changed", where, "warning", "Format changed", b.format, a.format);
  }
  if (!b.nullable && a.nullable) {
    c.add("nullable-changed", where, sev(dir, "info", "warning"), "Value may now be null", false, true);
  } else if (b.nullable && !a.nullable) {
    c.add("nullable-changed", where, sev(dir, "breaking", "info"), "Value may no longer be null", true, false);
  }
  if ((b.description ?? "") !== (a.description ?? "")) {
    c.add("description-changed", where, "info", "Field description changed; check for semantic changes", b.description, a.description);
  }

  diffEnum(b.enum, a.enum, dir, where, c);
  diffConstraints(b.constraints ?? {}, a.constraints ?? {}, dir, where, c);

  // Object properties
  const bProps = b.properties ?? {};
  const aProps = a.properties ?? {};
  const bReq = new Set(b.required ?? []);
  const aReq = new Set(a.required ?? []);
  for (const name of [...new Set([...Object.keys(bProps), ...Object.keys(aProps)])].sort()) {
    const field = `${where}.${name}`;
    const bp = bProps[name];
    const ap = aProps[name];
    if (bp && !ap) {
      c.add("property-removed", field, sev(dir, "warning", "breaking"),
        dir === "request" ? "Property is no longer accepted" : "Property is no longer returned");
      continue;
    }
    if (!bp && ap) {
      const required = aReq.has(name);
      c.add("property-added", field, dir === "request" && required ? "breaking" : "info",
        dir === "request" ? (required ? "New required property" : "New optional property") : "New property returned");
      continue;
    }
    if (!bp || !ap) continue;
    if (!bReq.has(name) && aReq.has(name)) {
      c.add("property-required", field, sev(dir, "breaking", "info"), "Property became required");
    } else if (bReq.has(name) && !aReq.has(name)) {
      c.add("property-optional", field, sev(dir, "info", "breaking"),
        dir === "request" ? "Property became optional" : "Property may now be absent from the response");
    }
    diffSchema(bp, ap, dir, field, c);
  }

  if (b.items && a.items) diffSchema(b.items, a.items, dir, `${where}[]`, c);

  if (b.additionalProperties !== false && a.additionalProperties === false && dir === "request") {
    c.add("additional-properties-closed", where, "breaking", "Unknown properties are no longer allowed");
  }

  if (b.variants || a.variants) {
    const bv = b.variants?.schemas ?? [];
    const av = a.variants?.schemas ?? [];
    if (b.variants?.kind !== a.variants?.kind || bv.length !== av.length) {
      c.add("variants-changed", where, sev(dir, "breaking", "warning"),
        `Polymorphic variants changed (${b.variants?.kind ?? "none"}:${bv.length} -> ${a.variants?.kind ?? "none"}:${av.length})`);
    } else {
      bv.forEach((v, i) => diffSchema(v, av[i]!, dir, `${where}<${b.variants!.kind}[${i}]>`, c));
    }
  }
}

function diffEnum(b: unknown[] | undefined, a: unknown[] | undefined, dir: Direction, where: string, c: ChangeCollector) {
  if (!b && !a) return;
  if (!b && a) {
    c.add("enum-added", where, sev(dir, "breaking", "info"), "Value is now restricted to an enum", undefined, a);
    return;
  }
  if (b && !a) {
    c.add("enum-removed", where, sev(dir, "info", "warning"), "Enum restriction removed; any value is now possible", b);
    return;
  }
  const removed = b!.filter((v) => !a!.some((x) => json(x) === json(v)));
  const added = a!.filter((v) => !b!.some((x) => json(x) === json(v)));
  if (removed.length > 0) {
    c.add("enum-values-removed", where, sev(dir, "breaking", "info"), `Enum values removed: ${removed.map(String).join(", ")}`, removed);
  }
  if (added.length > 0) {
    c.add("enum-values-added", where, sev(dir, "info", "warning"),
      `Enum values added: ${added.map(String).join(", ")}${dir === "response" ? "; exhaustive client handling may break" : ""}`,
      undefined, added);
  }
}

const LOWER_BOUNDS = new Set<ConstraintKey>(["minimum", "minLength", "minItems"]);

function diffConstraints(
  b: Partial<Record<ConstraintKey, number | string>>,
  a: Partial<Record<ConstraintKey, number | string>>,
  dir: Direction,
  where: string,
  c: ChangeCollector,
) {
  for (const key of CONSTRAINT_KEYS) {
    const bv = b[key];
    const av = a[key];
    if (bv === av) continue;

    let tighter: boolean | undefined;
    if (bv === undefined) tighter = true;
    else if (av === undefined) tighter = false;
    else if (typeof bv === "number" && typeof av === "number") tighter = LOWER_BOUNDS.has(key) ? av > bv : av < bv;

    // A changed pattern can't be ordered; flag it for review.
    const severity: Severity =
      tighter === undefined ? "warning" : tighter ? sev(dir, "breaking", "info") : sev(dir, "info", "warning");
    c.add("constraint-changed", where,
      severity, `${key} changed${tighter === undefined ? "" : tighter ? " (stricter)" : " (looser)"}`, bv, av);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
