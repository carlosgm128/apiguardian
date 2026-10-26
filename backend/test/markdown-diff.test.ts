import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffMarkdown, lineDiff } from "../src/markdown/diff.js";
import { extractEndpoints, parseSections } from "../src/markdown/sections.js";

const v1 = readFileSync("backend/test/fixtures/docs-v1.md", "utf8");
const v2 = readFileSync("backend/test/fixtures/docs-v2.md", "utf8");

describe("parseSections", () => {
  it("builds heading paths and ignores headings inside code fences", () => {
    const keys = parseSections(v1).map((s) => s.key);
    expect(keys).toEqual([
      "Petstore API",
      "Petstore API > Authentication",
      "Petstore API > Pets",
      "Petstore API > Pets > List pets",
      "Petstore API > Pets > Delete a pet",
      "Petstore API > Rate limits",
    ]);
  });

  it("makes duplicate heading paths unique", () => {
    const keys = parseSections("# A\nx\n# A\ny").map((s) => s.key);
    expect(keys).toEqual(["A", "A (2)"]);
  });
});

describe("extractEndpoints", () => {
  it("finds METHOD /path mentions", () => {
    expect(extractEndpoints("Call `GET /pets` or POST /pets/{id}.")).toEqual(["GET /pets", "POST /pets/{id}"]);
  });
});

describe("diffMarkdown", () => {
  const diff = diffMarkdown(v1, v2);
  const unit = (id: string) => diff.units.find((u) => u.id === id);

  it("reports identical docs as unchanged", () => {
    expect(diffMarkdown(v1, v1).units).toEqual([]);
  });

  it("detects removed sections and the endpoints they documented", () => {
    const removed = unit("md:Petstore API > Pets > Delete a pet");
    expect(removed?.status).toBe("removed");
    expect(removed?.changes.map((c) => [c.kind, c.severity])).toEqual([
      ["section-removed", "warning"],
      ["endpoint-mention-removed", "breaking"],
    ]);
  });

  it("detects moved sections instead of remove + add", () => {
    const moved = unit("md:Petstore API > Operations > Rate limits");
    expect(moved?.changes.map((c) => c.kind)).toEqual(["section-moved"]);
    expect(unit("md:Petstore API > Rate limits")).toBeUndefined();
  });

  it("ignores heading-only parent sections", () => {
    expect(unit("md:Petstore API > Operations")).toBeUndefined();
  });

  it("includes a line diff for edited sections", () => {
    const auth = unit("md:Petstore API > Authentication");
    expect(auth?.diff).toContain("- No authentication is required.");
    expect(auth?.diff).toContain("+ Send your key in the `X-API-Key` header on every request.");
  });
});

describe("lineDiff", () => {
  it("collapses unchanged lines far from edits", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "d", "e", "f", "G"].join("\n");
    expect(lineDiff(before, after)).toBe(["  e", "  f", "- g", "+ G"].join("\n"));
  });
});
