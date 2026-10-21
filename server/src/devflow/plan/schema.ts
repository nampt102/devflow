import { z } from "zod";
import { AgentOutputError, describeIssues, extractJsonObject, unsafePath } from "../agent-stage/output.js";

// Output contract of the Planner agent (openspec/changes/add-tech-plan-stage, design D5).
// Strict on purpose: unknown keys are rejected, not ignored. Text is Vietnamese; file names and code keep their spelling.

const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax: number, min = 0) => z.array(line(itemMax)).min(min).max(max);
const taskId = z.string().regex(/^T[1-9][0-9]?$/);

export const TASK_SIZES = ["S", "M", "L"] as const;

export const planTaskSchema = z.strictObject({
  id: taskId,
  title: line(200),
  system: line(64).nullable(),
  description: line(1500),
  size: z.enum(TASK_SIZES),
  files: z
    .array(
      z.strictObject({
        path: line(300),
        line: z.number().int().min(1).max(10_000_000).nullable(),
        change: line(300),
      }),
    )
    .max(20),
  dependsOn: z.array(taskId).max(10),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

export const planOutputSchema = z.strictObject({
  summary: line(800),
  approach: line(3000),
  tasks: z.array(planTaskSchema).min(1).max(30),
  dataChanges: list(10, 300),
  apiChanges: list(10, 300),
  testPlan: list(20, 400, 1),
  risks: list(10, 300),
  openQuestions: list(10, 300),
  confidence: z.enum(["low", "medium", "high"]),
});
export type PlanOutput = z.infer<typeof planOutputSchema>;

/** The task ids in a dependency cycle, or null. */
function findCycle(tasks: readonly PlanTask[]): string | null {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") return true;
    state.set(id, "visiting");
    for (const d of deps.get(id) ?? []) if (visit(d)) return true;
    state.set(id, "done");
    return false;
  };
  for (const t of tasks) if (visit(t.id)) return t.id;
  return null;
}

/** Checks a plan beyond the schema: task ids, dependencies, systems and paths. Messages carry no agent text. */
export function checkPlanTasks(tasks: readonly PlanTask[], allowedSystemKeys: readonly string[]): void {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new AgentOutputError("tasks has a duplicate id");
    ids.add(t.id);
  }
  const allowed = new Set(allowedSystemKeys);
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) throw new AgentOutputError("a task depends on itself");
      if (!ids.has(d)) throw new AgentOutputError("a task depends on an id that is not in the plan");
    }
    if (allowed.size === 0) {
      if (t.system !== null) throw new AgentOutputError("no system is assigned: every task needs system null");
      if (t.files.length) throw new AgentOutputError("no system is assigned: tasks cannot name files");
    } else if (t.system === null || !allowed.has(t.system)) {
      throw new AgentOutputError("a task names a system that was not assigned to this request");
    }
    if (t.files.some((f) => unsafePath(f.path))) throw new AgentOutputError("a task has a path outside the repository");
  }
  if (findCycle(tasks)) throw new AgentOutputError("task dependencies form a cycle");
}

/** Parse the agent's text. `allowedSystemKeys` are the systems assigned to the request. */
export function parsePlanOutput(text: string, allowedSystemKeys: readonly string[]): PlanOutput {
  const parsed = planOutputSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) throw new AgentOutputError(`output does not match the schema (${describeIssues(parsed.error.issues)})`);
  checkPlanTasks(parsed.data.tasks, allowedSystemKeys);
  return parsed.data;
}

const SIZE_LABEL: Record<PlanTask["size"], string> = { S: "S (dưới nửa ngày)", M: "M (1–2 ngày)", L: "L (trên 2 ngày)" };

/** Readable text of the plan for the review screen (what `comment_text` stores). */
export function planCommentMarkdown(d: PlanOutput): string {
  const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
  const task = (t: PlanTask) =>
    [
      `- **${t.id}** ${t.title} · cỡ ${SIZE_LABEL[t.size]}${t.system ? ` · ${t.system}` : ""}${t.dependsOn.length ? ` · sau ${t.dependsOn.join(", ")}` : ""}`,
      `  ${t.description}`,
      ...t.files.map((f) => `  - ${f.path}${f.line ? `:${f.line}` : ""}: ${f.change}`),
    ].join("\n");
  const parts = [
    d.summary,
    `**Hướng giải quyết**\n${d.approach}`,
    `**Task**\n${d.tasks.map(task).join("\n")}`,
    d.dataChanges.length ? `**Thay đổi dữ liệu**\n${bullets(d.dataChanges)}` : null,
    d.apiChanges.length ? `**Thay đổi API**\n${bullets(d.apiChanges)}` : null,
    `**Kế hoạch test**\n${bullets(d.testPlan)}`,
    d.risks.length ? `**Rủi ro**\n${bullets(d.risks)}` : null,
    d.openQuestions.length ? `**Câu hỏi mở**\n${bullets(d.openQuestions)}` : null,
  ];
  return parts.filter(Boolean).join("\n\n").slice(0, 20_000);
}
