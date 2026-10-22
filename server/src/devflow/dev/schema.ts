import { z } from "zod";
import { AgentOutputError, describeIssues, extractJsonObject } from "../agent-stage/output.js";
import type { PublishedRepo } from "./publish.js";

// Output contract of the Dev agent (openspec/changes/add-dev-stage, design D6).
// Strict on purpose: unknown keys are rejected, not ignored. DevFlow adds the facts the agent cannot vouch for
// (branch, commits, diff size, pull request) itself after it has checked the diff; they are not part of this contract.

const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax: number) => z.array(line(itemMax)).max(max);

export const DEV_TASK_STATUSES = ["done", "partial", "skipped"] as const;

export const devOutputSchema = z.strictObject({
  summary: line(800),
  tasks: z
    .array(z.strictObject({ id: z.string().regex(/^T[1-9][0-9]?$/), status: z.enum(DEV_TASK_STATUSES), notes: line(500) }))
    .min(1)
    .max(30),
  // the commands the agent ran to check its work and what they said; an empty tail is a command that printed nothing
  checks: z
    .array(z.strictObject({ system: line(64), command: line(500), passed: z.boolean(), outputTail: z.string().trim().max(2000) }))
    .max(20),
  openQuestions: list(10, 300),
  risks: list(10, 300),
  confidence: z.enum(["low", "medium", "high"]),
});
export type DevOutput = z.infer<typeof devOutputSchema>;

/**
 * Checks the report against what DevFlow asked for: every task of the request is reported exactly once and nothing
 * else, and checks name only systems the agent worked on. Messages carry no agent text.
 */
export function checkDevOutput(out: DevOutput, taskIds: readonly string[], systemKeys: readonly string[]): void {
  const asked = new Set(taskIds);
  const seen = new Set<string>();
  for (const t of out.tasks) {
    if (!asked.has(t.id)) throw new AgentOutputError("tasks names an id that is not in the approved plan for this request");
    if (seen.has(t.id)) throw new AgentOutputError("tasks has a duplicate id");
    seen.add(t.id);
  }
  if (seen.size !== asked.size) throw new AgentOutputError("tasks must report every task of the plan that was given to you");
  const systems = new Set(systemKeys);
  if (out.checks.some((c) => !systems.has(c.system))) throw new AgentOutputError("a check names a system that was not given to you");
}

/** Parse the agent's text. `taskIds` and `systemKeys` are what request.md listed. */
export function parseDevOutput(text: string, taskIds: readonly string[], systemKeys: readonly string[]): DevOutput {
  const parsed = devOutputSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) throw new AgentOutputError(`output does not match the schema (${describeIssues(parsed.error.issues)})`);
  checkDevOutput(parsed.data, taskIds, systemKeys);
  return parsed.data;
}

/** What DevFlow found for one system after the run: a draft pull request, no commit, or a diff it refused to push. */
export type DevRepoResult =
  | PublishedRepo
  | { system: string; branch: string; baseBranch: string; baseSha: string; noChanges: true }
  | { system: string; branch: string; baseBranch: string; baseSha: string; blocked: { kind: string; paths: string[] } };

const BLOCKED_LABEL: Record<string, string> = {
  forbidden_paths: "đã sửa file bị cấm (CI, .env, khóa...)",
  diff_too_large: "thay đổi quá lớn",
  binary_too_large: "có file nhị phân quá lớn",
  submodule_change: "có thay đổi submodule",
  wrong_branch: "commit không nằm trên nhánh của yêu cầu",
  history_rewritten: "agent đã viết lại lịch sử git",
};
const STATUS_LABEL = { done: "xong", partial: "một phần", skipped: "bỏ qua" } as const;

/** Readable text of the Dev report for the review screen (what `comment_text` stores). */
export function devCommentMarkdown(d: DevOutput, repos: readonly DevRepoResult[]): string {
  const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
  const repoLine = (r: DevRepoResult) => {
    if ("prUrl" in r) return `- **${r.system}**: [PR nháp #${r.prNumber}](${r.prUrl}) · nhánh \`${r.branch}\` · ${r.filesChanged} file, +${r.additions} −${r.deletions}${r.unprotectedWarning ? " · ⚠️ nhánh chính không được bảo vệ" : ""}`;
    if ("noChanges" in r) return `- **${r.system}**: agent không commit gì, không có PR.`;
    return `- **${r.system}**: KHÔNG đẩy lên GitHub: ${BLOCKED_LABEL[r.blocked.kind] ?? r.blocked.kind}${r.blocked.paths.length ? ` (${r.blocked.paths.slice(0, 10).join(", ")})` : ""}.`;
  };
  const parts = [
    d.summary,
    `**Pull request**\n${repos.map(repoLine).join("\n")}`,
    `**Task**\n${d.tasks.map((t) => `- ${t.id} (${STATUS_LABEL[t.status]}): ${t.notes}`).join("\n")}`,
    d.checks.length ? `**Kiểm tra**\n${d.checks.map((c) => `- ${c.passed ? "đạt" : "KHÔNG đạt"}: ${c.command} (${c.system})`).join("\n")}` : "**Kiểm tra:** agent không chạy lệnh kiểm tra nào.",
    d.risks.length ? `**Rủi ro**\n${bullets(d.risks)}` : null,
    d.openQuestions.length ? `**Câu hỏi mở**\n${bullets(d.openQuestions)}` : null,
  ];
  return parts.filter(Boolean).join("\n\n").slice(0, 20_000);
}
