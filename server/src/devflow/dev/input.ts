import { sanitizeUntrusted } from "../triage/triage-service.js";
import type { PlanOutput } from "../plan/schema.js";

// What the Dev agent is told to build: the tasks of the plan a reviewer approved (`data.approved` of the accepted
// tech_plan proposal) that belong to the systems it may change. Everything in it is data (requester and agent words).

const str = (v: unknown, max: number) => sanitizeUntrusted(String(v ?? ""), max).replace(/\s+/g, " ").trim();
const PLAN_CAP = 14_000;

/** Ids of the plan's tasks for the given systems, in plan order: what the agent must report on. */
export const devTaskIds = (plan: Pick<PlanOutput, "tasks">, systemKeys: readonly string[]): string[] =>
  plan.tasks.filter((t) => t.system !== null && systemKeys.includes(t.system)).map((t) => t.id);

/** The approved plan as plain text for request.md, limited to the tasks of `systemKeys`. */
export function approvedPlanText(plan: PlanOutput, systemKeys: readonly string[]): string {
  const mine = new Set(devTaskIds(plan, systemKeys));
  const others = plan.tasks.filter((t) => !mine.has(t.id)).map((t) => t.id);
  const bullets = (title: string, items: readonly string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${str(i, 600)}`)] : []);
  const tasks = plan.tasks
    .filter((t) => mine.has(t.id))
    .flatMap((t) => [
      `${t.id} [${t.size}] system ${t.system}: ${str(t.title, 200)}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`,
      `  ${str(t.description, 1500)}`,
      ...t.files.map((f) => `  - ${str(f.path, 300)}${f.line ? `:${f.line}` : ""}: ${str(f.change, 300)}`),
    ]);
  return [
    `Summary: ${str(plan.summary, 800)}`,
    `Approach: ${str(plan.approach, 3000)}`,
    "Tasks you must do (in build order):",
    ...tasks,
    ...(others.length ? [`Tasks ${others.join(", ")} belong to systems you do not work on: leave them out.`] : []),
    ...bullets("Data changes", plan.dataChanges),
    ...bullets("API changes", plan.apiChanges),
    ...bullets("Test plan", plan.testPlan),
    ...bullets("Risks", plan.risks),
  ]
    .join("\n")
    .slice(0, PLAN_CAP);
}
