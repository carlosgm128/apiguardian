import type { Change, DiffResult, Severity, WorkUnit } from "../types.js";
import { extractEndpoints, parseSections, type Section } from "./sections.js";

// Markdown has no schema, so the deterministic pass only finds *where* the
// docs changed (sections added/removed/moved/edited, endpoint mentions).
// Judging what an edit means for clients is left to the worker agents.

export function diffMarkdown(baselineText: string, candidateText: string): DiffResult {
  const baseline = parseSections(baselineText);
  const candidate = parseSections(candidateText);
  const byKey = (list: Section[]) => new Map(list.map((s) => [s.key, s]));
  const bMap = byKey(baseline);
  const aMap = byKey(candidate);

  const pairs: { b?: Section; a?: Section; moved?: boolean }[] = [];
  for (const b of baseline) {
    const a = aMap.get(b.key);
    if (a) pairs.push({ b, a });
  }

  // A section whose heading text is unique on both sides but whose path
  // changed was most likely moved rather than removed and re-added.
  const unmatchedB = baseline.filter((s) => !aMap.has(s.key));
  const unmatchedA = candidate.filter((s) => !bMap.has(s.key));
  const uniqueByHeading = (list: Section[]) => {
    const counts = new Map<string, number>();
    for (const s of list) counts.set(norm(s.heading), (counts.get(norm(s.heading)) ?? 0) + 1);
    return new Map(list.filter((s) => counts.get(norm(s.heading)) === 1).map((s) => [norm(s.heading), s]));
  };
  const movableA = uniqueByHeading(unmatchedA);
  const movedA = new Set<Section>();
  for (const [heading, b] of uniqueByHeading(unmatchedB)) {
    const a = movableA.get(heading);
    if (a) {
      pairs.push({ b, a, moved: true });
      movedA.add(a);
    }
  }
  const movedB = new Set(pairs.filter((p) => p.moved).map((p) => p.b));
  for (const b of unmatchedB) if (!movedB.has(b)) pairs.push({ b });
  for (const a of unmatchedA) if (!movedA.has(a)) pairs.push({ a });

  const units: WorkUnit[] = [];
  for (const { b, a, moved } of pairs) {
    const id = `md:${(a ?? b)!.key}`;
    const changes: Change[] = [];
    const add = (kind: string, severity: Severity, message: string, before?: unknown, after?: unknown) =>
      changes.push({
        id: `${id}#${changes.length + 1}`,
        unitId: id,
        kind,
        location: (a ?? b)!.key,
        severity,
        message,
        ...(before !== undefined && { before }),
        ...(after !== undefined && { after }),
      });

    // Heading-only sections (just a parent of subsections) carry no content of their own.
    if (b && !a && b.body !== "") add("section-removed", "warning", `Section removed (was at line ${b.line})`);
    if (!b && a && a.body !== "") add("section-added", "info", `Section added at line ${a.line}`);
    if (b && a && moved) add("section-moved", "info", "Section moved", b.key, a.key);
    if (b && a && norm(b.body) !== norm(a.body)) {
      add("section-changed", "info", "Section content changed; semantic impact needs review");
    }

    const bEndpoints = b ? extractEndpoints(b.body) : [];
    const aEndpoints = a ? extractEndpoints(a.body) : [];
    for (const ep of bEndpoints.filter((e) => !aEndpoints.includes(e))) {
      add("endpoint-mention-removed", b && a ? "warning" : "breaking", `Endpoint ${ep} no longer mentioned here`, ep);
    }
    for (const ep of aEndpoints.filter((e) => !bEndpoints.includes(e))) {
      add("endpoint-mention-added", "info", `Endpoint ${ep} now mentioned here`, undefined, ep);
    }

    if (changes.length === 0) continue;
    units.push({
      id,
      format: "markdown",
      title: (a ?? b)!.key,
      status: !b ? "added" : !a ? "removed" : "modified",
      baseline: b?.body,
      candidate: a?.body,
      changes,
      diff: b && a ? lineDiff(b.body, a.body) : undefined,
    });
  }

  return { format: "markdown", units };
}

function norm(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n")
    .toLowerCase();
}

/** Unified-style line diff with 2 lines of context between changes. */
export function lineDiff(before: string, after: string, context = 2): string {
  const b = before.split("\n");
  const a = after.split("\n");
  // LCS table; sections are small enough for O(n*m).
  const lcs: number[][] = Array.from({ length: b.length + 1 }, () => new Array<number>(a.length + 1).fill(0));
  for (let i = b.length - 1; i >= 0; i--) {
    for (let j = a.length - 1; j >= 0; j--) {
      lcs[i]![j] = b[i] === a[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { tag: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) {
      ops.push({ tag: " ", line: b[i]! });
      i++;
      j++;
    } else if (i < b.length && (j >= a.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ tag: "-", line: b[i]! });
      i++;
    } else {
      ops.push({ tag: "+", line: a[j]! });
      j++;
    }
  }

  const keep = ops.map((op, idx) =>
    op.tag !== " " || ops.slice(Math.max(0, idx - context), idx + context + 1).some((o) => o.tag !== " "),
  );
  const out: string[] = [];
  ops.forEach((op, idx) => {
    if (keep[idx]) out.push(`${op.tag} ${op.line}`);
    else if (keep[idx - 1]) out.push("…");
  });
  return out.join("\n");
}
