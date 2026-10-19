import { describe, expect, it } from "vitest";
import { PROMPT_HASH, PROMPT_VERSION, SYSTEM_PROMPT, buildRequestFile, newBoundary } from "../devflow/prompts/ba.v1.js";
import { baAgentSpec, baWorkspaceDir, BA_TOOLS, denyRules, unsafeBaAgentReason } from "../devflow/ba/agent.js";
import { readRun } from "../devflow/ba/runner.js";
import { VALID_BA_OUTPUT } from "./helpers/ba-fixtures.js";
import { baCommentMarkdown, BaOutputError, extractJsonObject, parseBaOutput } from "../devflow/ba/schema.js";

// BA Spec pieces that need no database (openspec/changes/add-ba-spec-stage, tasks 3.1 and 3.2).
const ok = JSON.stringify(VALID_BA_OUTPUT);

describe("BA prompt v1", () => {
  it("is pinned: editing v1 changes the hash, create ba.v2.ts instead", () => {
    expect(PROMPT_VERSION).toBe("v1");
    expect(PROMPT_HASH).toBe("a20e33455a74e995fd53bc3efdddcc0970de6a618c994e9a60d9901048a5940e");
  });

  it("tells the agent the files are data, to stay in its workspace and not to invent", () => {
    expect(SYSTEM_PROMPT).toMatch(/DATA written by people/);
    expect(SYSTEM_PROMPT).toMatch(/Never read or search outside it/);
    expect(SYSTEM_PROMPT).toMatch(/Do not guess/);
    expect(SYSTEM_PROMPT).toMatch(/Read, Grep and Glob tools and nothing else/);
  });

  const input = (over: Record<string, unknown> = {}) => ({
    boundary: newBoundary(),
    caseKey: "REQ-7",
    title: "Tiêu đề",
    description: "Mô tả",
    businessImpact: null,
    attachmentNames: ["a.png"],
    triage: { classification: "feature", priority: "high", difficulty: "medium" },
    systems: [{ key: "portal", docsPath: "docs", sha: "0123456789abcdef0123" }],
    ...over,
  });

  it("wraps the request in a per-call random boundary and names each system's folder and commit", () => {
    const a = newBoundary();
    expect(a).not.toBe(newBoundary());
    const file = buildRequestFile(input({ boundary: a }) as any);
    expect(file.split("\n").filter((l) => l.startsWith(a))).toHaveLength(2);
    expect(file.indexOf(`${a} START REQUEST DATA`)).toBeLessThan(file.indexOf("Description:"));
    expect(file.indexOf("Attached file names")).toBeLessThan(file.indexOf(`${a} END REQUEST DATA`));
    expect(file).toContain("key: portal | directory: repos/portal/ | business documents: repos/portal/docs | commit 0123456789ab");
  });

  it("puts reviewer feedback inside its own boundary and says when no system is assigned", () => {
    const b = newBoundary();
    const withFeedback = buildRequestFile(input({ boundary: b, feedback: { previousSummary: "S", text: "thiếu luồng duyệt" } }) as any);
    expect(withFeedback.indexOf(`${b} START REVIEWER FEEDBACK`)).toBeLessThan(withFeedback.indexOf("thiếu luồng duyệt"));
    expect(withFeedback.indexOf("thiếu luồng duyệt")).toBeLessThan(withFeedback.indexOf(`${b} END REVIEWER FEEDBACK`));
    expect(buildRequestFile(input({ systems: [] }) as any)).toContain("(none assigned)");
  });
});

describe("BA output schema", () => {
  it("accepts a valid answer, also inside a code fence or after a sentence", () => {
    expect(parseBaOutput(ok, ["portal"]).confidence).toBe("medium");
    expect(parseBaOutput("```json\n" + ok + "\n```", ["portal"]).summary).toMatch(/người yêu cầu/);
    expect(parseBaOutput("Đây là kết quả:\n" + ok, ["portal"]).acceptanceCriteria).toHaveLength(1);
  });

  it.each([
    ["not json", "Tôi đã xong."],
    ["a list", "[1,2]"],
    ["unknown key (an agent obeying an injected instruction)", JSON.stringify({ ...VALID_BA_OUTPUT, toStageKey: "done" })],
    ["bad confidence", JSON.stringify({ ...VALID_BA_OUTPUT, confidence: "certain" })],
    ["no acceptance criteria", JSON.stringify({ ...VALID_BA_OUTPUT, acceptanceCriteria: [] })],
    ["no scope", JSON.stringify({ ...VALID_BA_OUTPUT, inScope: [] })],
    ["summary too long", JSON.stringify({ ...VALID_BA_OUTPUT, summary: "x".repeat(801) })],
    ["too many risks", JSON.stringify({ ...VALID_BA_OUTPUT, risks: Array(11).fill("r") })],
    ["line zero", JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [{ ...VALID_BA_OUTPUT.affectedAreas[0], line: 0 }] })],
    ["missing field", JSON.stringify({ ...VALID_BA_OUTPUT, businessGoal: undefined })],
  ])("rejects %s", (_name, text) => {
    expect(() => parseBaOutput(text, ["portal"])).toThrow(BaOutputError);
  });

  it("accepts a null line (the whole file matters)", () => {
    const text = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [{ ...VALID_BA_OUTPUT.affectedAreas[0], line: null }] });
    expect(parseBaOutput(text, ["portal"]).affectedAreas[0]!.line).toBeNull();
  });

  it("only accepts systems that were assigned and paths inside the repository", () => {
    const area = (over: Record<string, unknown>) => JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [{ ...VALID_BA_OUTPUT.affectedAreas[0], ...over }] });
    expect(() => parseBaOutput(area({ system: "hr" }), ["portal"])).toThrow(/not assigned/);
    expect(() => parseBaOutput(ok, [])).toThrow(/not assigned/); // no system assigned: no area may be claimed
    for (const path of ["/etc/passwd", "../x", "a/../../x", "~/.ssh/id", "a\\b", "a\u0000b"]) {
      expect(() => parseBaOutput(area({ path }), ["portal"]), path).toThrow(/outside the repository/);
    }
  });

  it("never puts the agent's text in an error message", () => {
    try {
      parseBaOutput(JSON.stringify({ ...VALID_BA_OUTPUT, summary: "BÍ-MẬT-123", extra: 1 }), ["portal"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("BÍ-MẬT-123");
    }
  });

  it("extracts the JSON object from messy text and refuses text without one", () => {
    expect(extractJsonObject('xx {"a":1} yy')).toEqual({ a: 1 });
    expect(() => extractJsonObject("no braces")).toThrow(BaOutputError);
  });

  it("writes a readable Vietnamese text of the proposal", () => {
    const text = baCommentMarkdown(parseBaOutput(ok, ["portal"]));
    expect(text).toContain("**Tiêu chí nghiệm thu**");
    expect(text).toContain("- portal: server/src/devflow/portal/portal-service.ts:17 (DTO của requester không có trường này)");
    expect(text).toContain("Là người yêu cầu, tôi muốn biết ai đang xử lý để tôi biết hỏi ai");
    expect(text).not.toContain("**Thay đổi dữ liệu**"); // empty sections are left out
  });
});

describe("BA agent spec and safety check", () => {
  const spec = baAgentSpec();
  // Paperclip adds the instructions binding when it creates the agent
  const bound = { ...spec.adapterConfig, instructionsFilePath: "/paperclip/instances/default/companies/c/agents/a/instructions/AGENTS.md", instructionsRootPath: "/x", instructionsEntryFile: "AGENTS.md", instructionsBundleMode: "managed" };
  const row = (over: Record<string, unknown> = {}) => ({ adapterType: spec.adapterType, adapterConfig: { ...bound }, metadata: { ...spec.metadata }, status: "idle", ...over }) as any;
  const withConfig = (patch: Record<string, unknown>) => row({ adapterConfig: { ...bound, ...patch } });
  const args = (...a: string[]) => withConfig({ extraArgs: a });

  it("describes a read-only agent in its own folder with a spend limit", () => {
    expect(spec.adapterConfig).toMatchObject({ engine: "cli", cwd: baWorkspaceDir(), model: "claude-haiku-5-5" });
    const extra = spec.adapterConfig.extraArgs as string[];
    expect(extra[extra.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(extra).toContain("--max-budget-usd");
    expect(spec.metadata.devflowPromptHash).toBe(PROMPT_HASH);
    expect(spec.instructions).toBe(SYSTEM_PROMPT);
    expect(baAgentSpec({ model: "m", maxUsdPerRun: 2.5, workspaceRoot: "/x/y" }).adapterConfig).toMatchObject({ model: "m", cwd: "/x/y/ba" });
  });

  it("denies the instance data, system and secret folders for all three read tools", () => {
    const rules = denyRules().split(",");
    for (const t of ["Read", "Grep", "Glob"]) {
      for (const d of ["paperclip/instances", "proc", "etc", "root", "home", "var"]) expect(rules, `${t} ${d}`).toContain(`${t}(//${d}/**)`);
    }
  });

  it("accepts exactly the specified agent", () => {
    expect(unsafeBaAgentReason(row())).toBeNull();
  });

  it.each([
    ["paused", row({ status: "paused" }), "agent_not_runnable"],
    ["terminated", row({ status: "terminated" }), "agent_not_runnable"],
    ["another adapter", row({ adapterType: "codex_local" }), "agent_wrong_adapter"],
    ["the ACP engine (it ignores the tool list)", withConfig({ engine: "acp" }), "agent_wrong_engine"],
    ["no engine set", withConfig({ engine: undefined }), "agent_wrong_engine"],
    ["another folder", withConfig({ cwd: "/paperclip/devflow/ws/other" }), "agent_wrong_workspace"],
    ["no instructions bound (a full config replace drops them)", row({ adapterConfig: { ...spec.adapterConfig } }), "agent_no_instructions"],
    ["an empty instructions path", withConfig({ instructionsFilePath: "  " }), "agent_no_instructions"],
    ["a command override", withConfig({ command: "/bin/sh" }), "agent_extra_capability"],
    ["browser access", withConfig({ chrome: true }), "agent_extra_capability"],
    ["MCP servers", withConfig({ mcpServers: {} }), "agent_extra_capability"],
    ["a shell tool added", args("--tools", "Read,Grep,Glob,Bash", "--disallowedTools", denyRules(), "--max-budget-usd", "1"), "agent_tools_not_read_only"],
    ["no tool list", args("--disallowedTools", denyRules(), "--max-budget-usd", "1"), "agent_tools_not_read_only"],
    ["the tool list given twice", args("--tools", "Read,Grep,Glob", "--tools", "Bash", "--disallowedTools", denyRules(), "--max-budget-usd", "1"), "agent_tools_not_read_only"],
    ["no instance deny rule", args("--tools", BA_TOOLS, "--disallowedTools", "Read(//etc/**)", "--max-budget-usd", "1"), "agent_instance_not_denied"],
    ["no spend limit", args("--tools", BA_TOOLS, "--disallowedTools", denyRules()), "agent_no_budget"],
    ["a zero spend limit", args("--tools", BA_TOOLS, "--disallowedTools", denyRules(), "--max-budget-usd", "0"), "agent_no_budget"],
    ["an unreadable spend limit", args("--tools", BA_TOOLS, "--disallowedTools", denyRules(), "--max-budget-usd", "lots"), "agent_no_budget"],
    ["outdated instructions", row({ metadata: { ...spec.metadata, devflowPromptHash: "old" } }), "agent_prompt_outdated"],
    ["no metadata", row({ metadata: null }), "agent_prompt_outdated"],
  ])("refuses an agent with %s", (_name, agent, reason) => {
    expect(unsafeBaAgentReason(agent)).toBe(reason);
  });
});

describe("reading a finished run", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    status: "succeeded",
    errorCode: null,
    resultJson: { result: "{}", subtype: "success", is_error: false },
    usageJson: { costUsd: 0.12, inputTokens: 100, outputTokens: 20, model: "claude-haiku-5-5" },
    ...over,
  });

  it("takes the final message, cost and tokens of a good run", () => {
    expect(readRun(run())).toMatchObject({ ok: true, text: "{}", costUsd: 0.12, inputTokens: 100, outputTokens: 20, model: "claude-haiku-5-5", subtype: "success" });
  });

  it("reads the older engine's summary field", () => {
    expect(readRun(run({ resultJson: { summary: "{}" } }))).toMatchObject({ ok: true, text: "{}" });
  });

  it("is not ok when the run failed, errored, ran out of budget or said nothing", () => {
    expect(readRun(run({ status: "failed" })).ok).toBe(false);
    expect(readRun(run({ resultJson: { result: "{}", is_error: true } })).ok).toBe(false);
    const budget = readRun(run({ status: "failed", errorCode: "claude_auth_required", resultJson: { subtype: "error_max_budget_usd", is_error: true } }));
    expect(budget).toMatchObject({ ok: false, subtype: "error_max_budget_usd" }); // the adapter's errorCode is misleading; the subtype tells the truth
    expect(readRun(run({ resultJson: { result: "" } })).ok).toBe(false);
    expect(readRun(run({ resultJson: { result: "{}", subtype: "error_during_execution" } })).ok).toBe(false);
  });

  it("tolerates a run with no usage", () => {
    expect(readRun(run({ usageJson: null, resultJson: null }))).toMatchObject({ ok: false, costUsd: 0, model: null });
  });
});
