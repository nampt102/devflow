import type { PlanDecision, PlanDetail, PlanEditable, PlanFile, PlanSize, PlanTask, PlanTaskEdit } from "../api/devflowPlan";
import { splitLines } from "./ba-review";

// Pure helpers for the DevFlow "Plan review" page: the plan as text the reviewer can edit, what changed, tasks grouped
// by system, and links to the code the agent cited.

export const PLAN_FIELD_LABELS: Record<keyof PlanEditable | "tasks", string> = {
  summary: "Summary",
  approach: "Approach",
  dataChanges: "Data changes",
  apiChanges: "API changes",
  testPlan: "Test plan",
  risks: "Risks",
  openQuestions: "Open questions",
  tasks: "Tasks",
};

export const SIZE_LABELS: Record<PlanSize, string> = { S: "S: under half a day", M: "M: one to two days", L: "L: more than two days" };

/** The editable fields as the reviewer sees them: text boxes, one item per line; tasks keep their own fields. */
export interface PlanDraft {
  summary: string;
  approach: string;
  dataChanges: string;
  apiChanges: string;
  testPlan: string;
  risks: string;
  openQuestions: string;
  tasks: PlanTaskEdit[];
}

const LIST_KEYS = ["dataChanges", "apiChanges", "testPlan", "risks", "openQuestions"] as const;
const TEXT_KEYS = ["summary", "approach"] as const;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const taskEditOf = (t: PlanTask): PlanTaskEdit => ({ id: t.id, title: t.title, description: t.description, size: t.size });

export function draftFromPlan(plan: PlanEditable & { tasks: PlanTask[] }): PlanDraft {
  return {
    summary: plan.summary,
    approach: plan.approach,
    dataChanges: plan.dataChanges.join("\n"),
    apiChanges: plan.apiChanges.join("\n"),
    testPlan: plan.testPlan.join("\n"),
    risks: plan.risks.join("\n"),
    openQuestions: plan.openQuestions.join("\n"),
    tasks: plan.tasks.map(taskEditOf),
  };
}

/** The draft as the values the server stores. */
export function planDraftValues(draft: PlanDraft): PlanEditable & { tasks: PlanTaskEdit[] } {
  return {
    summary: draft.summary.trim(),
    approach: draft.approach.trim(),
    dataChanges: splitLines(draft.dataChanges),
    apiChanges: splitLines(draft.apiChanges),
    testPlan: splitLines(draft.testPlan),
    risks: splitLines(draft.risks),
    openQuestions: splitLines(draft.openQuestions),
    tasks: draft.tasks.map((t) => ({ ...t, title: t.title.trim(), description: t.description.trim() })),
  };
}

/** Fields whose value differs from the agent's ("tasks" when any task title, description or size changed). */
export function changedPlanFields(plan: PlanEditable & { tasks: PlanTask[] }, draft: PlanDraft): Array<keyof PlanEditable | "tasks"> {
  const now = planDraftValues(draft);
  const out: Array<keyof PlanEditable | "tasks"> = [...TEXT_KEYS, ...LIST_KEYS].filter((k) => !sameJson(plan[k], now[k]));
  if (!sameJson(plan.tasks.map(taskEditOf), now.tasks)) out.push("tasks");
  return out;
}

/** Only the changed fields go to the server, so an untouched form accepts the plan as it is. */
export function planFinalPatch(plan: PlanEditable & { tasks: PlanTask[] }, draft: PlanDraft): PlanDecisionFinal | undefined {
  const now = planDraftValues(draft);
  const out: Record<string, unknown> = {};
  for (const k of changedPlanFields(plan, draft)) out[k] = now[k];
  return Object.keys(out).length ? (out as PlanDecisionFinal) : undefined;
}
type PlanDecisionFinal = Partial<PlanEditable> & { tasks?: PlanTaskEdit[] };

/** Why a decision cannot be sent yet, in words, or null when it can. */
export function planDecisionBlocker(decision: PlanDecision, draft: PlanDraft, reason: string): string | null {
  if (decision !== "approve" && !reason.trim()) return "Write the reason first.";
  if (decision === "approve") {
    const now = planDraftValues(draft);
    if (!now.summary) return "The summary cannot be empty.";
    if (!now.approach) return "The approach cannot be empty.";
    if (now.testPlan.length === 0) return "List at least one test.";
    if (now.tasks.some((t) => !t.title || !t.description)) return "Every task needs a title and a description.";
  }
  return null;
}

/** Tasks grouped by system in the order the agent listed them; tasks without a system come last. */
export function tasksBySystem(tasks: readonly PlanTask[]): Array<{ system: string | null; tasks: PlanTask[] }> {
  const groups: Array<{ system: string | null; tasks: PlanTask[] }> = [];
  for (const t of tasks) {
    const g = groups.find((x) => x.system === t.system);
    if (g) g.tasks.push(t);
    else groups.push({ system: t.system, tasks: [t] });
  }
  return groups.sort((a, b) => (a.system === null ? 1 : 0) - (b.system === null ? 1 : 0));
}

/** How many tasks of each size, e.g. "2 S, 1 M". */
export const sizeSummary = (sizes: Record<PlanSize, number>): string =>
  (["S", "M", "L"] as const)
    .filter((s) => sizes[s] > 0)
    .map((s) => `${sizes[s]} ${s}`)
    .join(", ") || "no tasks";

/** A link to a cited file at the commit the agent read, or null when the repository address is unknown. */
export function planFileUrl(repos: PlanDetail["repos"], system: string | null, file: PlanFile): string | null {
  const repo = repos.find((r) => r.system === system);
  if (!repo?.repoUrl) return null;
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return `${repo.repoUrl.replace(/\/+$/, "")}/blob/${repo.sha}/${path}${file.line ? `#L${file.line}` : ""}`;
}

export const planFileLabel = (file: PlanFile): string => `${file.path}${file.line ? `:${file.line}` : ""}`;

const seenKey = (companyId: string) => `devflow.plan.seenAt:${companyId}`;
export function readPlanSeenAt(companyId: string): number | null {
  try {
    const v = Number(localStorage.getItem(seenKey(companyId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function writePlanSeenAt(companyId: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(seenKey(companyId), String(at));
  } catch {
    /* storage can be blocked; the labels just do not persist */
  }
}

export const PLAN_FAILURE_LABELS: Record<string, string> = {
  "agent.plan_failed": "Run failed",
  "agent.plan_gave_up": "Gave up",
  "agent.plan_budget_paused": "Paused: daily spend cap",
};
