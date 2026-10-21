import type { Db } from "@paperclipai/db";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/ba.v1.js";
import {
  claudeTranscriptsDir,
  DEFAULT_WORKSPACE_ROOT,
  denyRules as stageDenyRules,
  findStageAgent,
  STAGE_TOOLS,
  stageAgentSpec,
  stageWorkspaceDir,
  unsafeStageAgentReason,
  type StageAgentRow,
  type StageAgentSpec,
} from "../agent-stage/agent.js";

// The BA agent of a company (openspec/changes/add-ba-spec-stage, design D3), on the shared stage-agent rules.

export { claudeTranscriptsDir, DEFAULT_WORKSPACE_ROOT };
export const BA_AGENT_NAME = "DevFlow BA";
export const BA_TOOLS = STAGE_TOOLS;
export const DEFAULT_MAX_USD_PER_RUN = 1;
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const BA_PROMPT = { role: PROMPT_ROLE, version: PROMPT_VERSION, hash: PROMPT_HASH, system: SYSTEM_PROMPT } as const;

export const baWorkspaceDir = (root: string = DEFAULT_WORKSPACE_ROOT) => stageWorkspaceDir("ba", root);
export const denyRules = (root: string = DEFAULT_WORKSPACE_ROOT): string => stageDenyRules("ba", root);
export type BaAgentSpec = StageAgentSpec;

/** What the agent must look like. The Anthropic key is added by the setup script as a secret reference. */
export function baAgentSpec(opts: { model?: string; maxUsdPerRun?: number; workspaceRoot?: string } = {}): BaAgentSpec {
  return stageAgentSpec({
    name: BA_AGENT_NAME,
    prompt: BA_PROMPT,
    model: opts.model || DEFAULT_MODEL,
    maxUsdPerRun: opts.maxUsdPerRun && opts.maxUsdPerRun > 0 ? opts.maxUsdPerRun : DEFAULT_MAX_USD_PER_RUN,
    maxTurnsPerRun: 60,
    timeoutSec: 900,
    workspaceRoot: opts.workspaceRoot,
  });
}

export function unsafeBaAgentReason(agent: StageAgentRow, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT): string | null {
  return unsafeStageAgentReason(agent, { role: "ba", promptHash: PROMPT_HASH, workspaceRoot });
}

/** The company's BA agent, or null when the setup script has not run for it. */
export const findBaAgent = (db: Db, companyId: string) => findStageAgent(db, companyId, "ba");
