import { describe, expect, it } from "vitest";
import type { PlanEditable, PlanTask } from "../api/devflowPlan";
import { changedPlanFields, draftFromPlan, planDecisionBlocker, planDraftValues, planFileLabel, planFileUrl, planFinalPatch, sizeSummary, tasksBySystem } from "./plan-review";

const task = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: "T1",
  title: "Thêm assigneeName vào DTO",
  system: "portal",
  description: "Đọc tên người xử lý trong portal-service.",
  size: "S",
  files: [{ path: "server/src/portal service.ts", line: 17, change: "thêm trường" }],
  dependsOn: [],
  ...over,
});
const plan = (over: Partial<PlanEditable & { tasks: PlanTask[] }> = {}) => ({
  summary: "Thêm tên người xử lý.",
  approach: "Mở rộng DTO.",
  dataChanges: [],
  apiChanges: ["GET trả thêm assigneeName"],
  testPlan: ["Test portal-service"],
  risks: [],
  openQuestions: ["Tên đầy đủ?"],
  tasks: [task(), task({ id: "T2", title: "Hiện tên", size: "M", dependsOn: ["T1"] })],
  ...over,
});

describe("plan as text", () => {
  it("round-trips the plan through the editable text and sends nothing when untouched", () => {
    const p = plan();
    const draft = draftFromPlan(p);
    const { tasks, ...text } = planDraftValues(draft);
    const { tasks: _t, ...pText } = p;
    expect(text).toEqual(pText);
    expect(tasks).toEqual(p.tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, size: t.size })));
    expect(changedPlanFields(p, draft)).toEqual([]);
    expect(planFinalPatch(p, draft)).toBeUndefined();
  });

  it("sends only the changed fields, and all tasks when one task changed", () => {
    const p = plan();
    const draft = draftFromPlan(p);
    draft.risks = "Lộ tên nhân viên\n\n";
    draft.tasks[1] = { ...draft.tasks[1]!, size: "L" };
    expect(changedPlanFields(p, draft)).toEqual(["risks", "tasks"]);
    const patch = planFinalPatch(p, draft)!;
    expect(patch.risks).toEqual(["Lộ tên nhân viên"]);
    expect(patch.tasks).toHaveLength(2);
    expect(patch.tasks![1]).toEqual({ id: "T2", title: "Hiện tên", description: task().description, size: "L" });
    expect(patch.summary).toBeUndefined();
  });

  it("explains what blocks a decision", () => {
    const draft = draftFromPlan(plan());
    expect(planDecisionBlocker("reject", draft, " ")).toBe("Write the reason first.");
    expect(planDecisionBlocker("request_changes", draft, "Thiếu migration")).toBeNull();
    expect(planDecisionBlocker("approve", draft, "")).toBeNull();
    expect(planDecisionBlocker("approve", { ...draft, testPlan: "" }, "")).toMatch(/test/);
    expect(planDecisionBlocker("approve", { ...draft, tasks: [{ ...draft.tasks[0]!, title: " " }, draft.tasks[1]!] }, "")).toMatch(/title/);
  });
});

describe("tasks and citations", () => {
  it("groups tasks by system in the agent's order, tasks without a system last", () => {
    const groups = tasksBySystem([task({ id: "T1", system: null }), task({ id: "T2", system: "hr" }), task({ id: "T3" }), task({ id: "T4", system: "hr" })]);
    expect(groups.map((g) => [g.system, g.tasks.map((t) => t.id)])).toEqual([
      ["hr", ["T2", "T4"]],
      ["portal", ["T3"]],
      [null, ["T1"]],
    ]);
  });

  it("summarises sizes", () => {
    expect(sizeSummary({ S: 2, M: 0, L: 1 })).toBe("2 S, 1 L");
    expect(sizeSummary({ S: 0, M: 0, L: 0 })).toBe("no tasks");
  });

  it("links a cited file at the commit the agent read", () => {
    const repos = [{ system: "portal", sha: "abc123", name: "Portal", repoUrl: "https://github.com/acme/portal/" }];
    const file = task().files[0]!;
    expect(planFileUrl(repos, "portal", file)).toBe("https://github.com/acme/portal/blob/abc123/server/src/portal%20service.ts#L17");
    expect(planFileUrl(repos, "hr", file)).toBeNull();
    expect(planFileUrl(repos, "portal", { ...file, line: null })).toBe("https://github.com/acme/portal/blob/abc123/server/src/portal%20service.ts");
    expect(planFileLabel(file)).toBe("server/src/portal service.ts:17");
  });
});
