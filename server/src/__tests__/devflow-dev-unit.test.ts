import { describe, expect, it } from "vitest";
import { AgentOutputError } from "../devflow/agent-stage/output.js";
import { DEV_RUNNER_ENVIRONMENT, DEV_TOOLS, devAgentSpec, devWorkspaceDir, unsafeDevAgentReason, unsafeRunnerEnvironmentReason, type DevAgentRow, type RunnerEnvironmentRow } from "../devflow/dev/agent.js";
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
    expect(PROMPT_HASH).toBe("bd07ce161d201bcd2af2f3143efe7a2f86baebecb14255d8a9c6085c146fca06");
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
    expect(file).toContain("key: portal | directory: .paperclip-repositories/portal/ | branch: devflow/REQ-3 (from main, commit 0123456789ab)");
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

describe("Dev agent configuration and the check before every run", () => {
  const ENV_ID = "11111111-1111-4111-8111-111111111111";
  const runner = (over: Partial<RunnerEnvironmentRow> & { config?: Record<string, unknown> } = {}): RunnerEnvironmentRow => ({
    id: ENV_ID,
    name: DEV_RUNNER_ENVIRONMENT,
    driver: "ssh",
    status: "active",
    ...over,
    config: { host: "devflow-runner", remoteWorkspacePath: "/paperclip/devflow/ws", knownHosts: "devflow-runner ssh-ed25519 AAAA", strictHostKeyChecking: true, ...over.config },
  });
  // what Paperclip stores for an agent made from the spec: the spec's config plus the binding of the instructions file
  const good = (over: Partial<DevAgentRow> = {}, cfg: Record<string, unknown> = {}): DevAgentRow => {
    const spec = devAgentSpec();
    return {
      adapterType: "claude_local",
      adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md", ...cfg },
      metadata: spec.metadata,
      status: "idle",
      defaultEnvironmentId: ENV_ID,
      ...over,
    };
  };
  const extra = (...args: string[]) => ({ extraArgs: args });

  it("publishes a spec that passes its own check, and nothing more than the prompt describes", () => {
    const spec = devAgentSpec();
    expect(spec.adapterConfig).toMatchObject({ cwd: devWorkspaceDir(), engine: "cli", extraArgs: ["--tools", DEV_TOOLS, "--max-budget-usd", "5"] });
    expect(spec.runnerEnvironment).toBe("devflow-runner");
    expect(spec.instructions).toBe(SYSTEM_PROMPT);
    expect(unsafeDevAgentReason(good(), runner())).toBeNull();
    expect(devAgentSpec({ model: "m", maxUsdPerRun: 2, workspaceRoot: "/x/ws" }).adapterConfig).toMatchObject({ model: "m", cwd: "/x/ws/dev", extraArgs: ["--tools", DEV_TOOLS, "--max-budget-usd", "2"] });
  });

  it.each([
    ["an agent that is paused", good({ status: "paused" }), runner(), "agent_not_runnable"],
    ["no environment on the agent (it would run in the server container)", good({ defaultEnvironmentId: null }), runner(), "agent_not_on_runner"],
    ["an environment that was deleted", good(), null, "agent_not_on_runner"],
    ["another environment than the one the agent points at", good(), runner({ id: "22222222-2222-4222-8222-222222222222" }), "agent_not_on_runner"],
    ["a local environment", good(), runner({ driver: "local" }), "runner_environment_invalid"],
    ["an environment with another name", good(), runner({ name: "some-ssh-box" }), "runner_environment_invalid"],
    ["an environment that is switched off", good(), runner({ status: "archived" }), "runner_environment_invalid"],
    ["another remote workspace path", good(), runner({ config: { remoteWorkspacePath: "/home/runner" } }), "runner_environment_invalid"],
    ["the host key not checked", good(), runner({ config: { strictHostKeyChecking: false } }), "runner_host_key_not_pinned"],
    ["no pinned host key", good(), runner({ config: { knownHosts: null } }), "runner_host_key_not_pinned"],
    ["another adapter", good({ adapterType: "codex_local" }), runner(), "agent_wrong_adapter"],
    ["the ACP engine, which ignores the arguments", good({}, { engine: "acp" }), runner(), "agent_wrong_engine"],
    ["another folder", good({}, { cwd: "/paperclip/devflow/ws/plan" }), runner(), "agent_wrong_workspace"],
    ["instructions not bound", good({}, { instructionsFilePath: "" }), runner(), "agent_no_instructions"],
    ["a custom command", good({}, { command: "bash" }), runner(), "agent_extra_capability"],
    ["browser access", good({}, { chrome: true }), runner(), "agent_extra_capability"],
    ["MCP servers", good({}, { mcpServers: {} }), runner(), "agent_extra_capability"],
    ["a tool added", good({}, extra("--tools", `${DEV_TOOLS},WebFetch`, "--max-budget-usd", "1")), runner(), "agent_tools_changed"],
    ["a tool removed", good({}, extra("--tools", "Read,Edit", "--max-budget-usd", "1")), runner(), "agent_tools_changed"],
    ["no tool list", good({}, extra("--max-budget-usd", "1")), runner(), "agent_tools_changed"],
    ["the tool list given twice", good({}, extra("--tools", DEV_TOOLS, "--tools", "Bash", "--max-budget-usd", "1")), runner(), "agent_tools_changed"],
    ["no spend limit", good({}, extra("--tools", DEV_TOOLS)), runner(), "agent_no_budget"],
    ["a zero spend limit", good({}, extra("--tools", DEV_TOOLS, "--max-budget-usd", "0")), runner(), "agent_no_budget"],
    ["an unreadable spend limit", good({}, extra("--tools", DEV_TOOLS, "--max-budget-usd", "lots")), runner(), "agent_no_budget"],
    ["outdated instructions", good({ metadata: { devflowPromptHash: "old" } }), runner(), "agent_prompt_outdated"],
  ] as const)("refuses %s", (_label, agent, environment, reason) => {
    expect(unsafeDevAgentReason(agent as DevAgentRow, environment as RunnerEnvironmentRow | null)).toBe(reason);
  });

  it("checks the runner environment against the configured workspace root", () => {
    expect(unsafeRunnerEnvironmentReason(runner({ config: { remoteWorkspacePath: "/x/ws" } }), "/x/ws")).toBeNull();
    expect(unsafeRunnerEnvironmentReason(runner(), "/x/ws")).toBe("runner_environment_invalid");
    expect(unsafeDevAgentReason(good({}, { cwd: "/x/ws/dev" }), runner({ config: { remoteWorkspacePath: "/x/ws" } }), "/x/ws")).toBeNull();
  });
});
