import type { Db } from "@paperclipai/db";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/dev.v1.js";
import {
  RUNNER_ENVIRONMENT,
  RUNNER_TOOLS,
  findRunnerAgent,
  runnerAgentProblem,
  runnerAgentSpec,
  runnerWorkspaceDir,
  unsafeRunnerAgentReason,
  type RunnerAgentRow,
  type RunnerAgentSpec,
  type RunnerEnvironmentRow,
} from "./runner-agent.js";

// The Dev agent of a company (openspec/changes/add-dev-stage, design D5): the shared rules for agents that run on the runner
// (runner-agent.ts) with the Dev prompt, folder and limits.

export const DEV_AGENT_NAME = "DevFlow Dev";
export const DEFAULT_DEV_MAX_USD_PER_RUN = 5;
export const DEFAULT_DEV_MODEL = "claude-sonnet-5-5";
export const DEV_GIT_NAME = "DevFlow Dev";
export const DEV_GIT_EMAIL = "dev@devflow.local";
export const DEV_TOOLS = RUNNER_TOOLS;
/** Name of the Paperclip SSH environment of the runner (scripts/devflow/setup-dev-runner.mjs). */
export const DEV_RUNNER_ENVIRONMENT = RUNNER_ENVIRONMENT;
export const DEV_PROMPT = { role: PROMPT_ROLE, version: PROMPT_VERSION, hash: PROMPT_HASH, system: SYSTEM_PROMPT } as const;

export const devWorkspaceDir = (root: string = DEFAULT_WORKSPACE_ROOT) => runnerWorkspaceDir("dev", root);

export type DevAgentSpec = RunnerAgentSpec;
export type DevAgentRow = RunnerAgentRow;
export type { RunnerEnvironmentRow };
export { unsafeRunnerEnvironmentReason, findAgentEnvironment } from "./runner-agent.js";

/** What the agent must look like. The Anthropic key and the environment id are added by the setup script. */
export function devAgentSpec(opts: { model?: string; maxUsdPerRun?: number; workspaceRoot?: string } = {}): DevAgentSpec {
  return runnerAgentSpec({
    name: DEV_AGENT_NAME,
    role: "dev",
    prompt: DEV_PROMPT,
    model: opts.model || DEFAULT_DEV_MODEL,
    maxUsdPerRun: opts.maxUsdPerRun && opts.maxUsdPerRun > 0 ? opts.maxUsdPerRun : DEFAULT_DEV_MAX_USD_PER_RUN,
    maxTurnsPerRun: 200,
    timeoutSec: 3600,
    workspaceRoot: opts.workspaceRoot,
    gitName: DEV_GIT_NAME,
    gitEmail: DEV_GIT_EMAIL,
  });
}

/** Why this agent must not run, or null (see `unsafeRunnerAgentReason`). */
export const unsafeDevAgentReason = (agent: DevAgentRow, environment: RunnerEnvironmentRow | null, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT) =>
  unsafeRunnerAgentReason(agent, environment, { role: "dev", promptHash: PROMPT_HASH, workspaceRoot });

/** The company's Dev agent, or null when the setup script has not run for it. */
export const findDevAgent = (db: Db, companyId: string) => findRunnerAgent(db, companyId, "dev");

/** Why the company's Dev agent would be refused right now: the setup state the script and the worker both read. */
export const devAgentProblem = (db: Db, companyId: string, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT) =>
  runnerAgentProblem(db, companyId, { role: "dev", promptHash: PROMPT_HASH, workspaceRoot });
