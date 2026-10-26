import type { Db } from "@paperclipai/db";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { findRunnerAgent, runnerAgentProblem, runnerAgentSpec, runnerWorkspaceDir, unsafeRunnerAgentReason, type RunnerAgentRow, type RunnerAgentSpec, type RunnerEnvironmentRow } from "../dev/runner-agent.js";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/qa.v1.js";

// The QA agent of a company (openspec/changes/add-qa-stage, design D3): an agent on the runner (dev/runner-agent.ts) with the
// QA prompt, its own folder and limits. It reads and runs, it never pushes.

export const QA_AGENT_NAME = "DevFlow QA";
export const DEFAULT_QA_MAX_USD_PER_RUN = 3;
export const DEFAULT_QA_MODEL = "claude-sonnet-5-5";
export const QA_GIT_NAME = "DevFlow QA";
export const QA_GIT_EMAIL = "qa@devflow.local";
export const QA_PROMPT = { role: PROMPT_ROLE, version: PROMPT_VERSION, hash: PROMPT_HASH, system: SYSTEM_PROMPT } as const;

export const qaWorkspaceDir = (root: string = DEFAULT_WORKSPACE_ROOT) => runnerWorkspaceDir("qa", root);

export type QaAgentSpec = RunnerAgentSpec;

/** What the agent must look like. The Anthropic key and the environment id are added by the setup script. */
export function qaAgentSpec(opts: { model?: string; maxUsdPerRun?: number; workspaceRoot?: string } = {}): QaAgentSpec {
  return runnerAgentSpec({
    name: QA_AGENT_NAME,
    role: "qa",
    prompt: QA_PROMPT,
    model: opts.model || DEFAULT_QA_MODEL,
    maxUsdPerRun: opts.maxUsdPerRun && opts.maxUsdPerRun > 0 ? opts.maxUsdPerRun : DEFAULT_QA_MAX_USD_PER_RUN,
    maxTurnsPerRun: 150,
    timeoutSec: 2400,
    workspaceRoot: opts.workspaceRoot,
    gitName: QA_GIT_NAME,
    gitEmail: QA_GIT_EMAIL,
  });
}

/** Why this agent must not run, or null (see `unsafeRunnerAgentReason`). */
export const unsafeQaAgentReason = (agent: RunnerAgentRow, environment: RunnerEnvironmentRow | null, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT) =>
  unsafeRunnerAgentReason(agent, environment, { role: "qa", promptHash: PROMPT_HASH, workspaceRoot });

/** The company's QA agent, or null when the setup script has not run for it. */
export const findQaAgent = (db: Db, companyId: string) => findRunnerAgent(db, companyId, "qa");

/** Why the company's QA agent would be refused right now: the setup state the script and the worker both read. */
export const qaAgentProblem = (db: Db, companyId: string, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT) =>
  runnerAgentProblem(db, companyId, { role: "qa", promptHash: PROMPT_HASH, workspaceRoot });
