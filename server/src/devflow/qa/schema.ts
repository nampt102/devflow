import { z } from "zod";
import { AgentOutputError, describeIssues, extractJsonObject } from "../agent-stage/output.js";

// Output contract of the QA agent (openspec/changes/add-qa-stage, design D4). Strict on purpose: unknown keys are rejected,
// not ignored. The agent reports; the recommendation is computed by DevFlow from the report (recommend()), never by the
// agent, and the person who signs off decides.

const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax: number) => z.array(line(itemMax)).max(max);

export const CRITERION_VERDICTS = ["pass", "fail", "not_verified"] as const;
export const CRITERION_HOW = ["automated", "code_reading", "manual"] as const;
export const ISSUE_SEVERITIES = ["high", "medium", "low"] as const;

const criterionId = z.string().regex(/^AC[1-9][0-9]?$/);

export const qaOutputSchema = z.strictObject({
  summary: line(800),
  criteria: z
    .array(z.strictObject({ id: criterionId, verdict: z.enum(CRITERION_VERDICTS), how: z.enum(CRITERION_HOW), evidence: line(600) }))
    .min(1)
    .max(30),
  checks: z.array(z.strictObject({ system: line(64), command: line(500), passed: z.boolean(), outputTail: z.string().trim().max(2000) })).max(20),
  issues: z.array(z.strictObject({ severity: z.enum(ISSUE_SEVERITIES), title: line(200), steps: line(800) })).max(20),
  manualTests: list(15, 300),
  confidence: z.enum(["low", "medium", "high"]),
});
export type QaOutput = z.infer<typeof qaOutputSchema>;

/**
 * Checks the report against what DevFlow asked for: every criterion given in request.md is judged exactly once and nothing
 * else, and checks name only systems the agent worked on. Messages carry no agent text.
 */
export function checkQaOutput(out: QaOutput, criterionIds: readonly string[], systemKeys: readonly string[]): void {
  const asked = new Set(criterionIds);
  const seen = new Set<string>();
  for (const c of out.criteria) {
    if (!asked.has(c.id)) throw new AgentOutputError("criteria names an id that is not an acceptance criterion of this request");
    if (seen.has(c.id)) throw new AgentOutputError("criteria has a duplicate id");
    seen.add(c.id);
  }
  if (seen.size !== asked.size) throw new AgentOutputError("criteria must judge every acceptance criterion that was given to you");
  const systems = new Set(systemKeys);
  if (out.checks.some((c) => !systems.has(c.system))) throw new AgentOutputError("a check names a system that was not given to you");
}

/** Parse the agent's text. `criterionIds` and `systemKeys` are what request.md listed. */
export function parseQaOutput(text: string, criterionIds: readonly string[], systemKeys: readonly string[]): QaOutput {
  const parsed = qaOutputSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) throw new AgentOutputError(`output does not match the schema (${describeIssues(parsed.error.issues)})`);
  checkQaOutput(parsed.data, criterionIds, systemKeys);
  return parsed.data;
}

const VERDICT_RANK: Record<QaOutput["criteria"][number]["verdict"], number> = { not_verified: 0, pass: 1, fail: 2 };
const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;

/**
 * One report out of the per-system ones. A criterion is `fail` if any system failed it, else `pass` if any system passed it
 * (another system's run says "not verified: concerns the other repository" for a criterion that is not its own), else
 * `not_verified`. The evidence is that of the deciding run. Lists are joined; the least confident rating wins.
 */
export function mergeQaOutputs(outputs: readonly QaOutput[]): QaOutput {
  if (outputs.length === 1) return outputs[0]!;
  const byId = new Map<string, QaOutput["criteria"][number]>();
  for (const o of outputs) {
    for (const c of o.criteria) {
      const have = byId.get(c.id);
      if (!have || VERDICT_RANK[c.verdict] > VERDICT_RANK[have.verdict]) byId.set(c.id, c);
    }
  }
  return {
    summary: outputs.map((o) => o.summary).join(" ").slice(0, 800),
    criteria: [...byId.values()].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2))),
    checks: outputs.flatMap((o) => o.checks).slice(0, 20),
    issues: outputs.flatMap((o) => o.issues).slice(0, 20),
    manualTests: outputs.flatMap((o) => o.manualTests).slice(0, 15),
    confidence: CONFIDENCE_ORDER[Math.min(...outputs.map((o) => CONFIDENCE_ORDER.indexOf(o.confidence)))]!,
  };
}

export type QaWarning = "qa_modified_branch" | "branch_moved";
export type QaRecommendation = { value: "approve" | "changes"; reasons: string[] };

/**
 * DevFlow's recommendation: "approve" only when every criterion passed, every command passed, there is no high issue and
 * the agent did not touch the branch; otherwise "changes" with the reasons. A suggestion for the person who signs off.
 */
export function recommend(out: QaOutput, warnings: readonly QaWarning[]): QaRecommendation {
  const reasons: string[] = [];
  const failed = out.criteria.filter((c) => c.verdict === "fail").map((c) => c.id);
  const notVerified = out.criteria.filter((c) => c.verdict === "not_verified").map((c) => c.id);
  if (failed.length) reasons.push(`criteria_failed:${failed.join(",")}`);
  if (notVerified.length) reasons.push(`criteria_not_verified:${notVerified.join(",")}`);
  if (out.checks.some((c) => !c.passed)) reasons.push("checks_failed");
  if (out.issues.some((i) => i.severity === "high")) reasons.push("high_issue");
  if (warnings.includes("qa_modified_branch")) reasons.push("qa_modified_branch");
  return { value: reasons.length === 0 ? "approve" : "changes", reasons };
}

const VERDICT_LABEL = { pass: "đạt", fail: "KHÔNG đạt", not_verified: "chưa kiểm được" } as const;
const HOW_LABEL = { automated: "chạy tự động", code_reading: "đọc code", manual: "cần kiểm thủ công" } as const;
const SEVERITY_LABEL = { high: "cao", medium: "vừa", low: "thấp" } as const;

/** Readable text of the QA report for the review screen (what `comment_text` stores). `criteriaText` maps AC ids to their text. */
export function qaCommentMarkdown(d: QaOutput, rec: QaRecommendation, criteriaText: Readonly<Record<string, string>>): string {
  const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
  const parts = [
    d.summary,
    `**Khuyến nghị của DevFlow:** ${rec.value === "approve" ? "nên duyệt" : "nên trả lại"}`,
    `**Tiêu chí nghiệm thu**\n${d.criteria.map((c) => `- ${c.id} (${VERDICT_LABEL[c.verdict]}, ${HOW_LABEL[c.how]}) ${criteriaText[c.id] ?? ""}\n  ${c.evidence}`).join("\n")}`,
    d.checks.length ? `**Lệnh đã chạy**\n${d.checks.map((c) => `- ${c.passed ? "đạt" : "KHÔNG đạt"}: ${c.command} (${c.system})`).join("\n")}` : "**Lệnh đã chạy:** agent không chạy lệnh nào.",
    d.issues.length ? `**Lỗi tìm thấy**\n${d.issues.map((i) => `- [${SEVERITY_LABEL[i.severity]}] ${i.title}: ${i.steps}`).join("\n")}` : null,
    d.manualTests.length ? `**Kiểm thủ công**\n${bullets(d.manualTests)}` : null,
  ];
  return parts.filter(Boolean).join("\n\n").slice(0, 20_000);
}
