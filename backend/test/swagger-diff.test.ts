import { describe, expect, it } from "vitest";
import { diffFiles } from "../src/orchestrator.js";
import { diffOpenApi } from "../src/swagger/diff.js";
import { normalizeDocument } from "../src/swagger/normalize.js";
import type { Change } from "../src/types.js";

const V1 = "backend/test/fixtures/petstore-v1.yaml";
const V2 = "backend/test/fixtures/petstore-v2.yaml";

const find = (changes: Change[], location: string, kind: string) =>
  changes.find((c) => c.location === location && c.kind === kind);

describe("OpenAPI diff (Swagger 2.0 baseline vs OpenAPI 3.0 candidate)", async () => {
  const diff = await diffFiles(V1, V2);
  const all = diff.units.flatMap((u) => u.changes);

  it("reports identical specs as unchanged, across both spec versions", async () => {
    expect((await diffFiles(V1, V1)).units).toEqual([]);
    expect((await diffFiles(V2, V2)).units).toEqual([]);
  });

  it("classifies operation-level changes", () => {
    expect(diff.units.find((u) => u.id === "DELETE /pets/{}")?.status).toBe("removed");
    expect(find(all, "DELETE /pets/{}", "operation-removed")?.severity).toBe("breaking");
    expect(find(all, "GET /owners", "operation-added")?.severity).toBe("info");
  });

  it("matches operations whose path parameter was renamed", () => {
    const unit = diff.units.find((u) => u.id === "GET /pets/{}");
    expect(unit?.status).toBe("modified");
    expect(find(all, 'GET /pets/{} > path parameter "petId"', "parameter-renamed")?.severity).toBe("info");
  });

  it("judges request changes from the client's side", () => {
    expect(find(all, "POST /pets > request body.species", "property-added")?.severity).toBe("breaking");
    expect(find(all, "POST /pets > request body.tag", "property-removed")?.severity).toBe("warning");
    expect(find(all, 'GET /pets > query parameter "limit"', "constraint-changed")?.severity).toBe("breaking");
    expect(find(all, 'GET /pets > query parameter "cursor"', "parameter-added")?.severity).toBe("info");
  });

  it("judges response changes from the client's side", () => {
    expect(find(all, "GET /pets/{} > response 200 > body.tag", "property-removed")?.severity).toBe("breaking");
    expect(find(all, "GET /pets/{} > response 200 > body.ownerId", "property-added")?.severity).toBe("info");
    expect(find(all, "GET /pets/{} > response 200 > body.status", "enum-values-added")?.severity).toBe("warning");
  });

  it("flags description edits so agents can catch semantic changes", () => {
    const weight = find(all, "GET /pets/{} > response 200 > body.weight", "description-changed");
    expect(weight).toMatchObject({ before: "Weight in kilograms", after: "Weight in pounds" });
  });

  it("does not report v2 parameter descriptions as schema changes", () => {
    expect(all.filter((c) => c.location.includes('"limit"') && c.kind === "description-changed")).toEqual([]);
  });

  it("detects auth becoming required and spec-wide changes", () => {
    expect(find(all, "GET /pets > security", "security-required")?.severity).toBe("breaking");
    const global = diff.units.find((u) => u.id === "spec:global")!;
    expect(global.changes.map((c) => c.kind).sort()).toEqual(
      ["security-scheme-added", "server-added", "server-removed", "version-changed"].sort(),
    );
  });

  it("handles recursive schemas without looping", () => {
    const doc = (desc: string) => {
      const node: any = { type: "object", properties: { label: { type: "string", description: desc } } };
      node.properties.children = { type: "array", items: node };
      return normalizeDocument({
        openapi: "3.0.0",
        info: { version: "1" },
        paths: { "/tree": { get: { responses: { "200": { content: { "application/json": { schema: node } } } } } } },
      });
    };
    const result = diffOpenApi(doc("old"), doc("new"));
    expect(result.units[0]!.changes.map((c) => c.location)).toEqual(["GET /tree > response 200 > body.label"]);
  });
});
