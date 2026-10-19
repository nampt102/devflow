import { z } from "zod";

// Output contract of the Triage agent (openspec/changes/add-intake-portal, step 6).
// Strict on purpose: unknown keys (e.g. a model obeying "set toStageKey") are rejected, not ignored.

export const REQUIRES_HUMAN_REASONS = [
  "sqlserver_migration",
  "production_change",
  "data_fix",
  "security_or_permission",
  "external_integration",
  "finance_or_payroll_data",
] as const;
export type RequiresHumanReason = (typeof REQUIRES_HUMAN_REASONS)[number];

const reason = z.string().trim().min(1).max(300);
const note = z.string().trim().min(1).max(300);

export const triageOutputSchema = z.strictObject({
  classification: z.enum(["bug", "feature", "request"]),
  classificationReason: reason,
  priority: z.enum(["urgent", "high", "medium", "low"]),
  priorityReason: reason,
  difficulty: z.enum(["easy", "medium", "hard"]),
  difficultyReason: reason,
  requiresHuman: z.boolean(),
  requiresHumanReasons: z.array(z.enum(REQUIRES_HUMAN_REASONS)).max(REQUIRES_HUMAN_REASONS.length),
  duplicateCandidates: z
    .array(z.strictObject({ caseKey: z.string().trim().min(1).max(64), reason }))
    .max(5),
  summary: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
  assumptions: z.array(note).max(5),
  openQuestions: z.array(note).max(5),
});
export type TriageOutput = z.infer<typeof triageOutputSchema>;

/** v4 adds the systems the request is about. v1 to v3 keep the schema above: their prompt hashes include it. */
export const triageOutputSchemaV4 = triageOutputSchema.extend({
  suggestedSystemKeys: z.array(z.string().trim().min(1).max(64)).max(3),
});
export type TriageOutputV4 = z.infer<typeof triageOutputSchemaV4>;

export class TriageOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageOutputError";
  }
}

/**
 * Parse the model's text. Error messages carry paths and rule names only, never the model's text,
 * because they are fed back to the model on retry and logged.
 */
export function parseTriageOutput(text: string, allowedCaseKeys: readonly string[], allowedSystemKeys: readonly string[] = []): TriageOutputV4 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TriageOutputError("output is not valid JSON");
  }
  const parsed = triageOutputSchemaV4.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
    throw new TriageOutputError(`output does not match the schema (${issues.join("; ")})`);
  }
  const allowed = new Set(allowedCaseKeys);
  for (const c of parsed.data.duplicateCandidates) {
    if (!allowed.has(c.caseKey)) throw new TriageOutputError("duplicateCandidates names a caseKey that was not offered");
  }
  const systems = new Set(allowedSystemKeys);
  for (const key of parsed.data.suggestedSystemKeys) {
    if (!systems.has(key)) throw new TriageOutputError("suggestedSystemKeys names a system that was not offered");
  }
  return parsed.data;
}
