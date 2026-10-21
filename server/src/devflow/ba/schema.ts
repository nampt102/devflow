import { z } from "zod";
import { AgentOutputError, describeIssues, extractJsonObject, unsafePath } from "../agent-stage/output.js";

// Output contract of the BA Spec agent (openspec/changes/add-ba-spec-stage, design D4).
// Strict on purpose: unknown keys are rejected, not ignored. Text is Vietnamese; file names and code keep their spelling.

const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax: number, min = 0) => z.array(line(itemMax)).min(min).max(max);

export const baOutputSchema = z.strictObject({
  summary: line(800),
  businessGoal: line(800),
  inScope: list(15, 300, 1),
  outOfScope: list(15, 300),
  userStories: z.array(z.strictObject({ asA: line(200), iWant: line(300), soThat: line(300) })).max(10),
  acceptanceCriteria: list(20, 400, 1),
  affectedAreas: z
    .array(
      z.strictObject({
        system: line(64),
        path: line(300),
        line: z.number().int().min(1).max(10_000_000).nullable(),
        why: line(300),
      }),
    )
    .max(30),
  dataChanges: list(10, 300),
  risks: list(10, 300),
  openQuestions: list(10, 300),
  confidence: z.enum(["low", "medium", "high"]),
});
export type BaOutput = z.infer<typeof baOutputSchema>;

export { AgentOutputError as BaOutputError, extractJsonObject };

/**
 * Parse the agent's text. Error messages carry paths and rule names only, never the agent's text, because they are
 * fed back to the agent on retry and logged. `allowedSystemKeys` are the systems assigned to the request.
 */
export function parseBaOutput(text: string, allowedSystemKeys: readonly string[]): BaOutput {
  const raw = extractJsonObject(text);
  const parsed = baOutputSchema.safeParse(raw);
  if (!parsed.success) throw new AgentOutputError(`output does not match the schema (${describeIssues(parsed.error.issues)})`);
  const allowed = new Set(allowedSystemKeys);
  for (const area of parsed.data.affectedAreas) {
    if (!allowed.has(area.system)) throw new AgentOutputError("affectedAreas names a system that was not assigned to this request");
    if (unsafePath(area.path)) throw new AgentOutputError("affectedAreas has a path outside the repository");
  }
  return parsed.data;
}

/** Readable text of the proposal for the review screen (what `comment_text` stores). */
export function baCommentMarkdown(d: BaOutput): string {
  const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
  const parts = [
    d.summary,
    `**Mục tiêu nghiệp vụ**\n${d.businessGoal}`,
    `**Trong phạm vi**\n${bullets(d.inScope)}`,
    d.outOfScope.length ? `**Ngoài phạm vi**\n${bullets(d.outOfScope)}` : null,
    d.userStories.length ? `**User story**\n${d.userStories.map((s) => `- Là ${s.asA}, tôi muốn ${s.iWant} để ${s.soThat}`).join("\n")}` : null,
    `**Tiêu chí nghiệm thu**\n${bullets(d.acceptanceCriteria)}`,
    d.affectedAreas.length
      ? `**Vùng ảnh hưởng**\n${d.affectedAreas.map((a) => `- ${a.system}: ${a.path}${a.line ? `:${a.line}` : ""} (${a.why})`).join("\n")}`
      : null,
    d.dataChanges.length ? `**Thay đổi dữ liệu**\n${bullets(d.dataChanges)}` : null,
    d.risks.length ? `**Rủi ro**\n${bullets(d.risks)}` : null,
    d.openQuestions.length ? `**Câu hỏi mở**\n${bullets(d.openQuestions)}` : null,
  ];
  return parts.filter(Boolean).join("\n\n").slice(0, 20_000);
}
