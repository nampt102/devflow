import type { Db } from "@paperclipai/db";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/plan.v1.js";
import { DEFAULT_WORKSPACE_ROOT, findStageAgent, stageAgentSpec, stageWorkspaceDir, unsafeStageAgentReason, type StageAgentRow, type StageAgentSpec } from "../agent-stage/agent.js";

// The Planner agent of a company (openspec/changes/add-tech-plan-stage, design D3), on the shared stage-agent rules.

export const PLAN_AGENT_NAME = "DevFlow Planner";
export const DEFAULT_PLAN_MAX_USD_PER_RUN = 2;
export const DEFAULT_PLAN_MODEL = "claude-sonnet-5-5";
export const PLAN_PROMPT = { role: PROMPT_ROLE, version: PROMPT_VERSION, hash: PROMPT_HASH, system: SYSTEM_PROMPT } as const;

export const planWorkspaceDir = (root: string = DEFAULT_WORKSPACE_ROOT) => stageWorkspaceDir("plan", root);

/** What the agent must look like. The Anthropic key is added by the setup script as a secret reference. */
export function planAgentSpec(opts: { model?: string; maxUsdPerRun?: number; workspaceRoot?: string } = {}): StageAgentSpec {
  return stageAgentSpec({
    name: PLAN_AGENT_NAME,
    prompt: PLAN_PROMPT,
    model: opts.model || DEFAULT_PLAN_MODEL,
    maxUsdPerRun: opts.maxUsdPerRun && opts.maxUsdPerRun > 0 ? opts.maxUsdPerRun : DEFAULT_PLAN_MAX_USD_PER_RUN,
    maxTurnsPerRun: 80,
    timeoutSec: 1200,
    workspaceRoot: opts.workspaceRoot,
  });
}

export function unsafePlanAgentReason(agent: StageAgentRow, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT): string | null {
  return unsafeStageAgentReason(agent, { role: "plan", promptHash: PROMPT_HASH, workspaceRoot });
}

/** The company's Planner agent, or null when the setup script has not run for it. */
export const findPlanAgent = (db: Db, companyId: string) => findStageAgent(db, companyId, "plan");
