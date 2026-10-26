export interface Section {
  /** Heading path joined with " > ", made unique within the document. */
  key: string;
  path: string[];
  heading: string;
  level: number;
  /** 1-based line of the heading in the source. */
  line: number;
  /** Text under the heading up to the next heading of any level. */
  body: string;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
export const PREAMBLE = "(preamble)";

export function parseSections(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  const seenKeys = new Map<string, number>();

  let current: { path: string[]; heading: string; level: number; line: number; body: string[] } = {
    path: [PREAMBLE],
    heading: PREAMBLE,
    level: 0,
    line: 1,
    body: [],
  };
  let fence: string | null = null;

  const flush = () => {
    const body = current.body.join("\n").trim();
    if (current.level === 0 && body === "") return;
    const baseKey = current.path.join(" > ");
    const count = (seenKeys.get(baseKey) ?? 0) + 1;
    seenKeys.set(baseKey, count);
    sections.push({
      key: count === 1 ? baseKey : `${baseKey} (${count})`,
      path: current.path,
      heading: current.heading,
      level: current.level,
      line: current.line,
      body,
    });
  };

  lines.forEach((line, i) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
    }
    const heading = fence === null && !fenceMatch ? HEADING.exec(line) : null;
    if (!heading) {
      current.body.push(line);
      return;
    }
    flush();
    const level = heading[1]!.length;
    const text = heading[2]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text });
    current = { path: stack.map((s) => s.text), heading: text, level, line: i + 1, body: [] };
  });
  flush();

  return sections;
}

const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+`?(\/[^\s`)"'<>]*)/g;

/** Endpoints mentioned as `METHOD /path` in prose, tables or code blocks. */
export function extractEndpoints(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(ENDPOINT)) found.add(`${m[1]} ${m[2]!.replace(/[.,;:]+$/, "")}`);
  return [...found].sort();
}
