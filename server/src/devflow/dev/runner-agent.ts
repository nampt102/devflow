import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, environments, type Db } from "@paperclipai/db";
import { DEFAULT_WORKSPACE_ROOT, type StageAgentRow, type StageAgentSpec } from "../agent-stage/agent.js";

// Agents that write files and run commands (Dev, QA) are only ever safe on the runner: a separate container with no database
// and no server secret, reached through the Paperclip SSH environment the setup script registers (openspec changes
// add-dev-stage and add-qa-stage). DevFlow publishes the exact configuration of such an agent and, before every run,
// refuses one that someone moved or loosened. The rules are the same for both roles; only the prompt, the folder and the
// limits differ.

export type RunnerRole = "dev" | "qa";
export const RUNNER_TOOLS = "Read,Grep,Glob,Edit,Write,Bash";
/** Name of the Paperclip SSH environment of the runner (scripts/devflow/setup-dev-runner.mjs). */
export const RUNNER_ENVIRONMENT = "devflow-runner";

/** The same path on the server (where DevFlow builds the workspace) and on the runner (where the agent works). */
export const runnerWorkspaceDir = (role: RunnerRole, root: string = DEFAULT_WORKSPACE_ROOT) => path.posix.join(root, role);

export type RunnerAgentSpec = StageAgentSpec & {
  /** the SSH environment the agent must be bound to; the setup script looks its id up by this name */
  runnerEnvironment: string;
};

/** What the agent must look like. The Anthropic key and the environment id are added by the setup script. */
export function runnerAgentSpec(opts: {
  name: string;
  role: RunnerRole;
  prompt: { version: string; hash: string; system: string };
  model: string;
  maxUsdPerRun: number;
  maxTurnsPerRun: number;
  timeoutSec: number;
  workspaceRoot?: string;
  gitName: string;
  gitEmail: string;
}): RunnerAgentSpec {
  return {
    name: opts.name,
    adapterType: "claude_local",
    adapterConfig: {
      cwd: runnerWorkspaceDir(opts.role, opts.workspaceRoot || DEFAULT_WORKSPACE_ROOT),
      model: opts.model,
      engine: "cli",
      maxTurnsPerRun: opts.maxTurnsPerRun,
      timeoutSec: opts.timeoutSec,
      extraArgs: ["--tools", RUNNER_TOOLS, "--max-budget-usd", String(opts.maxUsdPerRun)],
      // Paperclip recreates the repositories on the runner from git bundles and does not carry their local git config
      // (spike 2026-10-22), so the commit author comes from the environment. Not GIT_AUTHOR_*: Paperclip's strict secret
      // mode takes any key containing "auth" for a secret and refuses it as plain text. Git's own config-from-environment
      // variables (git 2.31+) have the same effect. The setup script adds the Anthropic key.
      env: { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: opts.gitName, GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: opts.gitEmail },
    },
    runtimeConfig: { heartbeat: { enabled: false } },
    metadata: { devflowRole: opts.role, devflowPromptVersion: opts.prompt.version, devflowPromptHash: opts.prompt.hash },
    instructions: opts.prompt.system,
    promptVersion: opts.prompt.version,
    promptHash: opts.prompt.hash,
    runnerEnvironment: RUNNER_ENVIRONMENT,
  };
}

export type RunnerAgentRow = StageAgentRow & { defaultEnvironmentId: string | null };
export type RunnerEnvironmentRow = { id: string; name: string; driver: string; status: string; config: unknown };

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Why the environment is not the runner, or null: reached over SSH with a pinned host key, at the workspace path. */
export function unsafeRunnerEnvironmentReason(env: RunnerEnvironmentRow, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT): string | null {
  const cfg = asRecord(env.config);
  if (env.name !== RUNNER_ENVIRONMENT || env.driver !== "ssh" || env.status !== "active") return "runner_environment_invalid";
  if (cfg.remoteWorkspacePath !== workspaceRoot) return "runner_environment_invalid";
  // an unpinned host key would let anything on the network answer as the runner
  if (cfg.strictHostKeyChecking === false || typeof cfg.knownHosts !== "string" || cfg.knownHosts.trim() === "") return "runner_host_key_not_pinned";
  return null;
}

/**
 * Why this agent must not run, or null. The reasons are short codes, shown in the failure list; they never include
 * configuration values. `environment` is the environment the agent is bound to (null when it has none).
 */
export function unsafeRunnerAgentReason(
  agent: RunnerAgentRow,
  environment: RunnerEnvironmentRow | null,
  expected: { role: RunnerRole; promptHash: string; workspaceRoot?: string },
): string | null {
  const workspaceRoot = expected.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  if (agent.status === "paused" || agent.status === "terminated") return "agent_not_runnable";
  // such an agent must never run in the server container
  if (!agent.defaultEnvironmentId || !environment || environment.id !== agent.defaultEnvironmentId) return "agent_not_on_runner";
  const envProblem = unsafeRunnerEnvironmentReason(environment, workspaceRoot);
  if (envProblem) return envProblem;
  if (agent.adapterType !== "claude_local") return "agent_wrong_adapter";
  const cfg = asRecord(agent.adapterConfig);
  if (cfg.engine !== "cli") return "agent_wrong_engine";
  if (cfg.cwd !== runnerWorkspaceDir(expected.role, workspaceRoot)) return "agent_wrong_workspace";
  if (typeof cfg.instructionsFilePath !== "string" || cfg.instructionsFilePath.trim() === "") return "agent_no_instructions";
  if (cfg.command !== undefined || cfg.chrome === true || cfg.mcpServers !== undefined) return "agent_extra_capability";
  const args = Array.isArray(cfg.extraArgs) ? cfg.extraArgs.map(String) : [];
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  // exactly the tools the prompt describes: no more (no MCP or web tools), no fewer
  if (args.filter((a) => a === "--tools").length !== 1 || valueOf("--tools") !== RUNNER_TOOLS) return "agent_tools_changed";
  const budget = Number(valueOf("--max-budget-usd"));
  if (!Number.isFinite(budget) || budget <= 0) return "agent_no_budget";
  if (asRecord(agent.metadata).devflowPromptHash !== expected.promptHash) return "agent_prompt_outdated";
  return null;
}

/** The company's agent of a role, or null when the setup script has not run for it. */
export async function findRunnerAgent(db: Db, companyId: string, role: RunnerRole): Promise<(RunnerAgentRow & { id: string; name: string }) | null> {
  const [row] = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      metadata: agents.metadata,
      defaultEnvironmentId: agents.defaultEnvironmentId,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), sql`${agents.metadata}->>'devflowRole' = ${role}`))
    .limit(1);
  return row ?? null;
}

/** The environment row the agent points at, or null. */
export async function findAgentEnvironment(db: Db, environmentId: string | null): Promise<RunnerEnvironmentRow | null> {
  if (!environmentId) return null;
  const [row] = await db
    .select({ id: environments.id, name: environments.name, driver: environments.driver, status: environments.status, config: environments.config })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row ?? null;
}

/** Why the company's agent would be refused right now: the setup state the script and the worker both read. */
export async function runnerAgentProblem(db: Db, companyId: string, expected: { role: RunnerRole; promptHash: string; workspaceRoot?: string }) {
  const agent = await findRunnerAgent(db, companyId, expected.role);
  if (!agent) return { agent: null, problem: `no_${expected.role}_agent` as const };
  const environment = await findAgentEnvironment(db, agent.defaultEnvironmentId);
  return { agent, problem: unsafeRunnerAgentReason(agent, environment, expected) };
}
