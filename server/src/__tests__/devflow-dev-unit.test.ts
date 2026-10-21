import { describe, expect, it } from "vitest";
import { AgentOutputError } from "../devflow/agent-stage/output.js";
import { approvedPlanText, devTaskIds } from "../devflow/dev/input.js";
import { checkDevOutput, parseDevOutput } from "../devflow/dev/schema.js";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT, buildRequestFile } from "../devflow/prompts/dev.v1.js";
import { newBoundary } from "../devflow/prompts/ba.v1.js";
import { VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";

// Dev prompt, output contract and input that need no database or runner (openspec/changes/add-dev-stage, task 3.2).
const plan = VALID_PLAN_OUTPUT;
const systemKey = plan.tasks[0]!.system!;
const taskIds = devTaskIds(plan, [systemKey]);

const report = (over: Record<string, unknown> = {}) => ({
  summary: "Đã thêm tên người xử lý vào trang yêu cầu.",
  tasks: taskIds.map((id) => ({ id, status: "done", notes: "Đã làm và commit." })),
  checks: [{ system: systemKey, command: "npm test", passed: true, outputTail: "Tests: 4 passed" }],
  openQuestions: [],
  risks: [],
  confidence: "medium",
  ...over,
});
const text = (over: Record<string, unknown> = {}) => JSON.stringify(report(over));

describe("Dev prompt v1", () => {
  it("is pinned: editing v1 changes the hash, create dev.v2.ts instead", () => {
    expect(PROMPT_ROLE).toBe("dev");
    expect(PROMPT_VERSION).toBe("v1");
    expect(PROMPT_HASH).toBe("62e7573b10a3e7ddf891a92d0a61327a2af509f1e4c65e48a0c0987c124373fe");
  });

  it("keeps the agent in its workspace, away from the network, git remotes and forbidden files", () => {
    expect(SYSTEM_PROMPT).toMatch(/DATA written by people/);
    expect(SYSTEM_PROMPT).toMatch(/Never read, write or run anything outside it/);
    expect(SYSTEM_PROMPT).toMatch(/Never push, fetch, pull, clone, add or change a remote/);
    expect(SYSTEM_PROMPT).toMatch(/Do not call other sites with curl, wget/);
    expect(SYSTEM_PROMPT).toMatch(/\.github\/workflows/);
    expect(SYSTEM_PROMPT).toMatch(/never edit, skip or delete a test only to make it pass/);
    expect(SYSTEM_PROMPT).toMatch(/under 3000 changed lines/);
  });

  it("puts the request, the approved spec and plan and the feedback inside the call's boundary", () => {
    const b = newBoundary();
    const file = buildRequestFile({
      boundary: b,
      caseKey: "REQ-3",
      title: "T",
      description: "D",
      businessImpact: null,
      attachmentNames: [],
      triage: null,
      systems: [{ key: "portal", branch: "devflow/REQ-3", baseBranch: "main", sha: "0123456789abcdef0123", testCommand: "cd web &&\n npm test", forbiddenPaths: ["deploy/**"] }],
      approvedSpec: "Acceptance criteria:\n- tiêu chí đã duyệt",
      approvedPlan: "T1 [S] system portal: làm việc đã duyệt",
      feedback: { previousSummary: "S", text: "thiếu test voucher hết hạn" },
    });
    const between = (name: string, needle: string) => file.indexOf(`${b} START ${name}`) < file.indexOf(needle) && file.indexOf(needle) < file.indexOf(`${b} END ${name}`);
    expect(between("APPROVED BA SPEC", "tiêu chí đã duyệt")).toBe(true);
    expect(between("APPROVED PLAN", "làm việc đã duyệt")).toBe(true);
    expect(between("REVIEWER FEEDBACK", "thiếu test voucher hết hạn")).toBe(true);
    // DevFlow's own lines sit outside the data, and a multi-line command stays on one line
    expect(file).toContain("key: portal | directory: repos/portal/ | branch: devflow/REQ-3 (from main, commit 0123456789ab)");
    expect(file).toContain("test command: cd web && npm test");
    expect(file).toContain("extra forbidden paths: deploy/**");
  });
});

describe("approved plan as agent input", () => {
  it("lists only the tasks of the given systems and names the others", () => {
    const mixed = { ...plan, tasks: [...plan.tasks, { ...plan.tasks[0]!, id: "T9", system: "other-system", title: "Việc của hệ thống khác" }] };
    expect(devTaskIds(mixed, [systemKey])).toEqual(taskIds);
    const out = approvedPlanText(mixed, [systemKey]);
    expect(out).toContain(`${plan.tasks[0]!.id} [${plan.tasks[0]!.size}] system ${systemKey}`);
    expect(out).toContain("Tasks T9 belong to systems you do not work on");
    expect(out).not.toContain("Việc của hệ thống khác");
    expect(out).toContain("Test plan:");
  });

  it("lists nothing to do when no task belongs to the systems", () => {
    expect(devTaskIds(plan, ["nobody"])).toEqual([]);
  });
});

describe("Dev output contract", () => {
  it("accepts a complete report, also in a code fence", () => {
    expect(parseDevOutput(text(), taskIds, [systemKey]).tasks).toHaveLength(taskIds.length);
    expect(parseDevOutput(`Xong.\n\`\`\`json\n${text()}\n\`\`\``, taskIds, [systemKey]).confidence).toBe("medium");
  });

  it("refuses unknown keys, bad values and oversized text", () => {
    for (const over of [
      { extra: 1 },
      { confidence: "certain" },
      { summary: "" },
      { summary: "x".repeat(801) },
      { tasks: [] },
      { tasks: [{ id: "T1", status: "finished", notes: "n" }] },
      { tasks: [{ id: "T1", status: "done", notes: "n", extra: true }] },
      { checks: [{ system: systemKey, command: "x", passed: "yes", outputTail: "" }] },
      { checks: [{ system: systemKey, command: "x", passed: true, outputTail: "x".repeat(2001) }] },
      { openQuestions: Array.from({ length: 11 }, () => "q") },
    ]) {
      expect(() => parseDevOutput(text(over), taskIds, [systemKey]), JSON.stringify(over).slice(0, 50)).toThrow(AgentOutputError);
    }
    expect(() => parseDevOutput("not json", taskIds, [systemKey])).toThrow(/not a JSON object/);
  });

  it("requires every task of the request exactly once and nothing else", () => {
    const one = { id: taskIds[0]!, status: "done", notes: "n" };
    expect(() => parseDevOutput(text({ tasks: [{ ...one, id: "T77" }] }), taskIds, [systemKey])).toThrow(/not in the approved plan/);
    expect(() => parseDevOutput(text({ tasks: [one, one] }), taskIds, [systemKey])).toThrow(/duplicate/);
    expect(() => parseDevOutput(text({ tasks: [] }), taskIds, [systemKey])).toThrow(AgentOutputError);
    const two = [...taskIds, "T8"];
    expect(() => parseDevOutput(text(), two, [systemKey])).toThrow(/every task/);
  });

  it("accepts an empty output tail and refuses a check for a system it was not given", () => {
    const ok = report({ checks: [{ system: systemKey, command: "dotnet build", passed: true, outputTail: "" }] });
    expect(() => checkDevOutput(parseDevOutput(JSON.stringify(ok), taskIds, [systemKey]), taskIds, [systemKey])).not.toThrow();
    const bad = report({ checks: [{ system: "elsewhere", command: "npm test", passed: true, outputTail: "" }] });
    expect(() => parseDevOutput(JSON.stringify(bad), taskIds, [systemKey])).toThrow(/system that was not given/);
  });
});
