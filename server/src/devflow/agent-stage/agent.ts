import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";

// A stage agent of a company (BA, Planner; ADR 0021). It is a normal Paperclip agent created through the API
// (scripts/devflow/setup-*-agent.mjs), because hiring has many side effects DevFlow must not copy. DevFlow owns what
// the agent is allowed to be: it publishes the exact configuration and, before every run, refuses an agent that
// someone changed (a shell tool, another folder, no budget, outdated instructions).

/** "dev" shares the run loop and the ledger names, but works elsewhere (the runner) and is not part of the read-only agents' deny rules. */
export type StageRole = "ba" | "plan" | "dev";
export const STAGE_ROLES: readonly StageRole[] = ["ba", "plan"];
export const STAGE_TOOLS = "Read,Grep,Glob";
export const DEFAULT_WORKSPACE_ROOT = "/paperclip/devflow/ws";
/** HOME of the agents' Claude Code process in the container. */
const AGENT_HOME = "/paperclip";

/**
 * One directory per stage for every company: runs are strictly one at a time across all stages and the directory is
 * emptied before and after each run, so no other company's request or repository is ever on disk next to the agent.
 */
export const stageWorkspaceDir = (role: StageRole, root: string = DEFAULT_WORKSPACE_ROOT) => path.posix.join(root, role);

/**
 * Where Claude Code writes the transcripts (and large tool results) of runs started in `cwd`: every company's runs of
 * a stage share it because they share the workspace, so it is emptied together with the workspace.
 */
export const claudeTranscriptsDir = (cwd: string, home: string) => path.posix.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

/**
 * Places the agent must not read even though its tools could reach them (Claude Code `Tool(//absolute/**)` rules).
 * `/paperclip/.claude` itself stays readable: Claude Code keeps large tool results of the current run under
 * `projects/`, and the worker empties the workspace's transcript folder instead.
 */
const DENIED_DIRS = [
  "/paperclip/instances",
  "/paperclip/.claude/sessions",
  "/paperclip/.claude/backups",
  "/paperclip/.claude/session-env",
  "/paperclip/.claude/shell-snapshots",
  "/paperclip/.cache",
  "/proc",
  "/sys",
  "/etc",
  "/root",
  "/home",
  "/var",
  "/run",
  "/boot",
  "/dev",
];
const DENIED_FILES = ["/paperclip/.claude.json"];
const TOOLS = ["Read", "Grep", "Glob"];

/** The other stages' workspaces and transcripts: they may hold another company's data left by a run that was cut off. */
const otherStageDirs = (role: StageRole, root: string) =>
  STAGE_ROLES.filter((r) => r !== role).flatMap((r) => [stageWorkspaceDir(r, root), claudeTranscriptsDir(stageWorkspaceDir(r, root), AGENT_HOME)]);

export const denyRules = (role: StageRole, root: string = DEFAULT_WORKSPACE_ROOT): string =>
  [
    ...[...DENIED_DIRS, ...otherStageDirs(role, root)].flatMap((d) => TOOLS.map((t) => `${t}(/${d}/**)`)),
    ...DENIED_FILES.flatMap((f) => TOOLS.map((t) => `${t}(/${f})`)),
  ].join(",");

export type StagePrompt = { role: StageRole; version: string; hash: string; system: string };

export type StageAgentSpec = {
  name: string;
  adapterType: "claude_local";
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
  instructions: string;
  promptVersion: string;
  promptHash: string;
};

/** What the agent must look like. The Anthropic key is added by the setup script as a secret reference. */
export function stageAgentSpec(opts: {
  name: string;
  prompt: StagePrompt;
  model: string;
  maxUsdPerRun: number;
  maxTurnsPerRun: number;
  timeoutSec: number;
  workspaceRoot?: string;
}): StageAgentSpec {
  const root = opts.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  return {
    name: opts.name,
    adapterType: "claude_local",
    adapterConfig: {
      cwd: stageWorkspaceDir(opts.prompt.role, root),
      model: opts.model,
      engine: "cli",
      maxTurnsPerRun: opts.maxTurnsPerRun,
      timeoutSec: opts.timeoutSec,
      extraArgs: ["--tools", STAGE_TOOLS, "--disallowedTools", denyRules(opts.prompt.role, root), "--max-budget-usd", String(opts.maxUsdPerRun)],
    },
    runtimeConfig: { heartbeat: { enabled: false } },
    metadata: { devflowRole: opts.prompt.role, devflowPromptVersion: opts.prompt.version, devflowPromptHash: opts.prompt.hash },
    instructions: opts.prompt.system,
    promptVersion: opts.prompt.version,
    promptHash: opts.prompt.hash,
  };
}

export type StageAgentRow = {
  adapterType: string;
  adapterConfig: unknown;
  metadata: unknown;
  status: string;
};

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Why this agent must not run, or null when it is exactly as safe as the spec. The reasons are short codes, shown
 * in the failure list; they never include configuration values.
 */
export function unsafeStageAgentReason(agent: StageAgentRow, expected: { role: StageRole; promptHash: string; workspaceRoot?: string }): string | null {
  const root = expected.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  if (agent.status === "paused" || agent.status === "terminated") return "agent_not_runnable";
  if (agent.adapterType !== "claude_local") return "agent_wrong_adapter";
  const cfg = asRecord(agent.adapterConfig);
  if (cfg.engine !== "cli") return "agent_wrong_engine";
  if (cfg.cwd !== stageWorkspaceDir(expected.role, root)) return "agent_wrong_workspace";
  // the instructions are what makes the model do its job; without a bundle bound to the agent it just chats
  if (typeof cfg.instructionsFilePath !== "string" || cfg.instructionsFilePath.trim() === "") return "agent_no_instructions";
  if (cfg.command !== undefined || cfg.chrome === true || cfg.mcpServers !== undefined) return "agent_extra_capability";
  const args = Array.isArray(cfg.extraArgs) ? cfg.extraArgs.map(String) : [];
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  if (args.filter((a) => a === "--tools").length !== 1 || valueOf("--tools") !== STAGE_TOOLS) return "agent_tools_not_read_only";
  const deny = new Set((valueOf("--disallowedTools") ?? "").split(","));
  if (!denyRules(expected.role, root).split(",").every((r) => deny.has(r))) return "agent_instance_not_denied";
  const budget = Number(valueOf("--max-budget-usd"));
  if (!Number.isFinite(budget) || budget <= 0) return "agent_no_budget";
  const meta = asRecord(agent.metadata);
  if (meta.devflowPromptHash !== expected.promptHash) return "agent_prompt_outdated";
  return null;
}

/** The company's agent for a stage, or null when the setup script has not run for it. */
export async function findStageAgent(db: Db, companyId: string, role: StageRole) {
  const [row] = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), sql`${agents.metadata}->>'devflowRole' = ${role}`))
    .limit(1);
  return row ?? null;
}
