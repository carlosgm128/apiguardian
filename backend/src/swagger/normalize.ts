import SwaggerParser from "@apidevtools/swagger-parser";

// Swagger 2.0 and OpenAPI 3.x are both reduced to this shape so the differ
// only has to understand one model. Everything is fully dereferenced.

export interface NSchema {
  type?: string;
  format?: string;
  enum?: unknown[];
  nullable?: boolean;
  description?: string;
  properties?: Record<string, NSchema>;
  required?: string[];
  items?: NSchema;
  additionalProperties?: boolean | NSchema;
  variants?: { kind: "oneOf" | "anyOf"; schemas: NSchema[] };
  constraints?: Partial<Record<ConstraintKey, number | string>>;
  /** Set instead of expanding a schema that refers back to itself. */
  circular?: string;
}

export const CONSTRAINT_KEYS = [
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
] as const;
export type ConstraintKey = (typeof CONSTRAINT_KEYS)[number];

export interface NParameter {
  name: string;
  in: string;
  required: boolean;
  deprecated: boolean;
  description?: string;
  schema: NSchema;
}

export interface NBody {
  required: boolean;
  contentTypes: string[];
  schema?: NSchema;
}

export interface NResponse {
  description?: string;
  contentTypes: string[];
  schema?: NSchema;
}

export interface NOperation {
  /** `METHOD /path/{}` - path parameter names erased so renames still match. */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  /** Keyed by `in:name`, except path params which are keyed by position (`path#0`). */
  parameters: Record<string, NParameter>;
  requestBody?: NBody;
  responses: Record<string, NResponse>;
  /** Each entry is one acceptable alternative, e.g. `apiKey` or `oauth2+mtls`. */
  security: string[];
}

export interface NSpec {
  version?: string;
  servers: string[];
  securitySchemes: Record<string, unknown>;
  operations: Record<string, NOperation>;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type Obj = Record<string, any>;

export async function loadOpenApi(file: string): Promise<NSpec> {
  const doc = (await SwaggerParser.dereference(file)) as Obj;
  return normalizeDocument(doc);
}

export function isOpenApiDocument(doc: unknown): boolean {
  return typeof doc === "object" && doc !== null && ("swagger" in doc || "openapi" in doc);
}

export function normalizeDocument(doc: Obj): NSpec {
  const isV2 = typeof doc.swagger === "string";
  const operations: Record<string, NOperation> = {};

  for (const [path, pathItem] of Object.entries<Obj>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op: Obj | undefined = pathItem[method];
      if (!op) continue;
      const normalized = normalizeOperation(doc, isV2, method, path, pathItem, op);
      operations[normalized.key] = normalized;
    }
  }

  return {
    version: doc.info?.version,
    servers: isV2 ? v2Servers(doc) : (doc.servers ?? []).map((s: Obj) => String(s.url)),
    securitySchemes: (isV2 ? doc.securityDefinitions : doc.components?.securitySchemes) ?? {},
    operations,
  };
}

function normalizeOperation(
  doc: Obj,
  isV2: boolean,
  method: string,
  path: string,
  pathItem: Obj,
  op: Obj,
): NOperation {
  const pathParamNames = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const key = `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;

  // Operation-level parameters override path-level ones with the same name+location.
  const rawParams = new Map<string, Obj>();
  for (const p of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    rawParams.set(`${p.in}:${p.name}`, p);
  }

  const parameters: Record<string, NParameter> = {};
  const formFields: Obj[] = [];
  let requestBody: NBody | undefined;

  for (const p of rawParams.values()) {
    if (isV2 && p.in === "body") {
      requestBody = {
        required: Boolean(p.required),
        contentTypes: op.consumes ?? doc.consumes ?? ["application/json"],
        schema: normalizeSchema(p.schema),
      };
      continue;
    }
    if (isV2 && p.in === "formData") {
      formFields.push(p);
      continue;
    }
    const paramKey =
      p.in === "path" && pathParamNames.includes(p.name)
        ? `path#${pathParamNames.indexOf(p.name)}`
        : `${p.in}:${p.name}`;
    parameters[paramKey] = {
      name: p.name,
      in: p.in,
      required: p.in === "path" ? true : Boolean(p.required),
      deprecated: Boolean(p.deprecated),
      description: p.description,
      // v2 puts type/format/items directly on the parameter; its description
      // belongs to the parameter, not the schema (as in v3).
      schema: normalizeSchema(isV2 ? { ...p, description: undefined } : (p.schema ?? {})),
    };
  }

  if (formFields.length > 0) {
    requestBody = {
      required: formFields.some((f) => f.required),
      contentTypes: op.consumes ?? doc.consumes ?? ["application/x-www-form-urlencoded"],
      schema: {
        type: "object",
        properties: Object.fromEntries(formFields.map((f) => [f.name, normalizeSchema(f)])),
        required: formFields.filter((f) => f.required).map((f) => f.name),
      },
    };
  }

  if (!isV2 && op.requestBody) {
    const content: Obj = op.requestBody.content ?? {};
    requestBody = {
      required: Boolean(op.requestBody.required),
      contentTypes: Object.keys(content),
      schema: pickContentSchema(content),
    };
  }

  const responses: Record<string, NResponse> = {};
  for (const [status, res] of Object.entries<Obj>(op.responses ?? {})) {
    if (isV2) {
      responses[status] = {
        description: res.description,
        contentTypes: res.schema ? (op.produces ?? doc.produces ?? ["application/json"]) : [],
        schema: res.schema ? normalizeSchema(res.schema) : undefined,
      };
    } else {
      const content: Obj = res.content ?? {};
      responses[status] = {
        description: res.description,
        contentTypes: Object.keys(content),
        schema: pickContentSchema(content),
      };
    }
  }

  const securityReqs: Obj[] = op.security ?? doc.security ?? [];
  const security = securityReqs
    .map((req) => Object.keys(req).sort().join("+"))
    .map((alt) => alt || "(none)")
    .sort();

  return {
    key,
    method: method.toUpperCase(),
    path,
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    deprecated: Boolean(op.deprecated),
    parameters,
    requestBody,
    responses,
    security,
  };
}

function v2Servers(doc: Obj): string[] {
  if (!doc.host) return doc.basePath ? [doc.basePath] : [];
  const schemes: string[] = doc.schemes ?? ["https"];
  return schemes.map((s) => `${s}://${doc.host}${doc.basePath ?? ""}`);
}

/** Prefer the JSON representation; fall back to the first media type. */
function pickContentSchema(content: Obj): NSchema | undefined {
  const types = Object.keys(content);
  const preferred = types.find((t) => /json/i.test(t)) ?? types[0];
  const schema = preferred ? content[preferred]?.schema : undefined;
  return schema ? normalizeSchema(schema) : undefined;
}

export function normalizeSchema(raw: Obj | undefined, seen = new Set<Obj>()): NSchema {
  if (!raw || typeof raw !== "object") return {};
  if (seen.has(raw)) return { circular: raw.title ?? raw.type ?? "schema" };
  seen.add(raw);
  try {
    // allOf is almost always composition/inheritance: flatten it into one object.
    if (Array.isArray(raw.allOf)) {
      const { allOf, ...rest } = raw;
      const parts = [rest, ...allOf].map((s: Obj) => normalizeSchema(s, seen));
      return mergeSchemas(parts);
    }

    const out: NSchema = {};
    let type = raw.type;
    if (Array.isArray(type)) {
      // OpenAPI 3.1: `type: [string, "null"]`
      if (type.includes("null")) out.nullable = true;
      type = type.filter((t: string) => t !== "null").join("|") || undefined;
    }
    if (type) out.type = String(type);
    if (!out.type && raw.properties) out.type = "object";
    if (raw.format) out.format = raw.format;
    if (Array.isArray(raw.enum)) out.enum = raw.enum;
    if (raw.nullable === true || raw["x-nullable"] === true) out.nullable = true;
    if (raw.description) out.description = raw.description;

    if (raw.properties) {
      out.properties = {};
      for (const [name, prop] of Object.entries<Obj>(raw.properties)) {
        out.properties[name] = normalizeSchema(prop, seen);
      }
    }
    if (Array.isArray(raw.required)) out.required = [...raw.required].sort();
    if (raw.items) out.items = normalizeSchema(raw.items, seen);
    if (raw.additionalProperties !== undefined) {
      out.additionalProperties =
        typeof raw.additionalProperties === "boolean"
          ? raw.additionalProperties
          : normalizeSchema(raw.additionalProperties, seen);
    }
    for (const kind of ["oneOf", "anyOf"] as const) {
      if (Array.isArray(raw[kind])) {
        out.variants = { kind, schemas: raw[kind].map((s: Obj) => normalizeSchema(s, seen)) };
      }
    }
    for (const key of CONSTRAINT_KEYS) {
      if (raw[key] !== undefined) (out.constraints ??= {})[key] = raw[key];
    }
    return out;
  } finally {
    seen.delete(raw);
  }
}

function mergeSchemas(parts: NSchema[]): NSchema {
  const merged: NSchema = {};
  for (const part of parts) {
    if (part.properties) merged.properties = { ...merged.properties, ...part.properties };
    if (part.required) merged.required = [...new Set([...(merged.required ?? []), ...part.required])].sort();
    if (part.constraints) merged.constraints = { ...merged.constraints, ...part.constraints };
    for (const key of ["type", "format", "enum", "nullable", "description", "items", "additionalProperties", "variants", "circular"] as const) {
      if (part[key] !== undefined) (merged as any)[key] = part[key];
    }
  }
  if (!merged.type && merged.properties) merged.type = "object";
  return merged;
}
