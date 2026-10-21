import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, environments, type Db } from "@paperclipai/db";
import { DEFAULT_WORKSPACE_ROOT, type StageAgentRow, type StageAgentSpec } from "../agent-stage/agent.js";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/dev.v1.js";

// The Dev agent of a company (openspec/changes/add-dev-stage, design D5). Unlike BA and Planner it writes files and
// runs commands, so it is only ever safe on the runner (a separate container with no database and no server
// secret), reached through the Paperclip SSH environment the setup script registers. DevFlow publishes the exact
// configuration and, before every run, refuses an agent that someone moved or loosened.

export const DEV_AGENT_NAME = "DevFlow Dev";
export const DEFAULT_DEV_MAX_USD_PER_RUN = 5;
export const DEFAULT_DEV_MODEL = "claude-sonnet-5-5";
export const DEV_TOOLS = "Read,Grep,Glob,Edit,Write,Bash";
/** Name of the Paperclip SSH environment of the runner (scripts/devflow/setup-dev-runner.mjs). */
export const DEV_RUNNER_ENVIRONMENT = "devflow-runner";
export const DEV_PROMPT = { role: PROMPT_ROLE, version: PROMPT_VERSION, hash: PROMPT_HASH, system: SYSTEM_PROMPT } as const;

/** The same path on the server (where DevFlow builds the workspace) and on the runner (where the agent works). */
export const devWorkspaceDir = (root: string = DEFAULT_WORKSPACE_ROOT) => path.posix.join(root, "dev");

export type DevAgentSpec = StageAgentSpec & {
  /** the SSH environment the agent must be bound to; the setup script looks its id up by this name */
  runnerEnvironment: string;
};

/** What the agent must look like. The Anthropic key and the environment id are added by the setup script. */
export function devAgentSpec(opts: { model?: string; maxUsdPerRun?: number; workspaceRoot?: string } = {}): DevAgentSpec {
  const maxUsd = opts.maxUsdPerRun && opts.maxUsdPerRun > 0 ? opts.maxUsdPerRun : DEFAULT_DEV_MAX_USD_PER_RUN;
  return {
    name: DEV_AGENT_NAME,
    adapterType: "claude_local",
    adapterConfig: {
      cwd: devWorkspaceDir(opts.workspaceRoot || DEFAULT_WORKSPACE_ROOT),
      model: opts.model || DEFAULT_DEV_MODEL,
      engine: "cli",
      maxTurnsPerRun: 200,
      timeoutSec: 3600,
      extraArgs: ["--tools", DEV_TOOLS, "--max-budget-usd", String(maxUsd)],
    },
    runtimeConfig: { heartbeat: { enabled: false } },
    metadata: { devflowRole: DEV_PROMPT.role, devflowPromptVersion: DEV_PROMPT.version, devflowPromptHash: DEV_PROMPT.hash },
    instructions: DEV_PROMPT.system,
    promptVersion: DEV_PROMPT.version,
    promptHash: DEV_PROMPT.hash,
    runnerEnvironment: DEV_RUNNER_ENVIRONMENT,
  };
}

export type DevAgentRow = StageAgentRow & { defaultEnvironmentId: string | null };
export type RunnerEnvironmentRow = { id: string; name: string; driver: string; status: string; config: unknown };

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Why the environment is not the runner, or null: reached over SSH with a pinned host key, at the workspace path. */
export function unsafeRunnerEnvironmentReason(env: RunnerEnvironmentRow, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT): string | null {
  const cfg = asRecord(env.config);
  if (env.name !== DEV_RUNNER_ENVIRONMENT || env.driver !== "ssh" || env.status !== "active") return "runner_environment_invalid";
  if (cfg.remoteWorkspacePath !== workspaceRoot) return "runner_environment_invalid";
  // an unpinned host key would let anything on the network answer as the runner
  if (cfg.strictHostKeyChecking === false || typeof cfg.knownHosts !== "string" || cfg.knownHosts.trim() === "") return "runner_host_key_not_pinned";
  return null;
}

/**
 * Why this agent must not run, or null. The reasons are short codes, shown in the failure list; they never include
 * configuration values. `environment` is the environment the agent is bound to (null when it has none).
 */
export function unsafeDevAgentReason(agent: DevAgentRow, environment: RunnerEnvironmentRow | null, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT): string | null {
  if (agent.status === "paused" || agent.status === "terminated") return "agent_not_runnable";
  // the Dev agent must never run in the server container
  if (!agent.defaultEnvironmentId || !environment || environment.id !== agent.defaultEnvironmentId) return "agent_not_on_runner";
  const envProblem = unsafeRunnerEnvironmentReason(environment, workspaceRoot);
  if (envProblem) return envProblem;
  if (agent.adapterType !== "claude_local") return "agent_wrong_adapter";
  const cfg = asRecord(agent.adapterConfig);
  if (cfg.engine !== "cli") return "agent_wrong_engine";
  if (cfg.cwd !== devWorkspaceDir(workspaceRoot)) return "agent_wrong_workspace";
  if (typeof cfg.instructionsFilePath !== "string" || cfg.instructionsFilePath.trim() === "") return "agent_no_instructions";
  if (cfg.command !== undefined || cfg.chrome === true || cfg.mcpServers !== undefined) return "agent_extra_capability";
  const args = Array.isArray(cfg.extraArgs) ? cfg.extraArgs.map(String) : [];
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  // exactly the tools the prompt describes: no more (no MCP or web tools), no fewer
  if (args.filter((a) => a === "--tools").length !== 1 || valueOf("--tools") !== DEV_TOOLS) return "agent_tools_changed";
  const budget = Number(valueOf("--max-budget-usd"));
  if (!Number.isFinite(budget) || budget <= 0) return "agent_no_budget";
  if (asRecord(agent.metadata).devflowPromptHash !== PROMPT_HASH) return "agent_prompt_outdated";
  return null;
}

/** The company's Dev agent, or null when the setup script has not run for it. */
export async function findDevAgent(db: Db, companyId: string): Promise<(DevAgentRow & { id: string; name: string }) | null> {
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
    .where(and(eq(agents.companyId, companyId), sql`${agents.metadata}->>'devflowRole' = ${DEV_PROMPT.role}`))
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

/** Why the company's Dev agent would be refused right now: the setup state the script and the worker both read. */
export async function devAgentProblem(db: Db, companyId: string, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT) {
  const agent = await findDevAgent(db, companyId);
  if (!agent) return { agent: null, problem: "no_dev_agent" as const };
  const environment = await findAgentEnvironment(db, agent.defaultEnvironmentId);
  return { agent, problem: unsafeDevAgentReason(agent, environment, workspaceRoot) };
}
