import { z } from "zod";

// Structured outputs the agents must return. Kept free of min/max/regex
// refinements so they stay within what structured outputs can enforce.

const Level = z.enum(["low", "medium", "high"]);

export const UnitFindingSchema = z.object({
  title: z.string().describe("Short name of the change"),
  what: z.string().describe("What changed, in terms a client developer understands"),
  how: z.string().describe("How it changed: before vs after, concretely"),
  severity: z.enum(["breaking", "warning", "info"]),
  baselineRef: z.string().describe("Where in the baseline docs this applies (operation, field, section)"),
  changeIds: z.array(z.string()).describe("Ids of the deterministic changes this finding explains; empty if it was found only by reading"),
});

export const UnitRiskSchema = z.object({
  description: z.string().describe("What could fail for a client built against the baseline docs"),
  failureScenario: z.string().describe("Concrete request/response situation that fails"),
  affectedConsumers: z.string().describe("Which clients are affected, e.g. 'clients that send X', 'generated SDKs'"),
  likelihood: Level,
  impact: Level,
  mitigation: z.string().describe("What a client or the API owner can do about it"),
});

export const UnitAnalysisSchema = z.object({
  summary: z.string(),
  findings: z.array(UnitFindingSchema),
  risks: z.array(UnitRiskSchema),
});

export const RiskReportSchema = z.object({
  overview: z.string().describe("A few sentences: overall compatibility verdict and the main themes"),
  risks: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(["critical", "high", "medium", "low"]),
      likelihood: Level,
      description: z.string(),
      failureScenario: z.string(),
      affectedUnits: z.array(z.string()).describe("Work unit ids this risk comes from"),
      mitigation: z.string(),
    }),
  ),
  crossCuttingNotes: z.array(z.string()).describe("Patterns spanning several units, e.g. a renamed field used everywhere"),
});

export type UnitFinding = z.infer<typeof UnitFindingSchema>;
export type UnitRisk = z.infer<typeof UnitRiskSchema>;
export type UnitAnalysis = z.infer<typeof UnitAnalysisSchema> & { unitId: string };
export type RiskReport = z.infer<typeof RiskReportSchema>;
