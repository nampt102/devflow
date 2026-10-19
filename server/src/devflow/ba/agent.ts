import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT } from "../prompts/ba.v1.js";

// The BA agent of a company (openspec/changes/add-ba-spec-stage, design D3). It is a normal Paperclip agent created
// through the API (scripts/devflow/setup-ba-agent.mjs), because hiring has many side effects DevFlow must not copy.
// DevFlow owns what the agent is allowed to be: it publishes the exact configuration here and, before every run,
// refuses an agent that someone changed (a shell tool, another folder, no budget, outdated instructions).

export const BA_AGENT_NAME = "DevFlow BA";
export const BA_TOOLS = "Read,Grep,Glob";
export const DEFAULT_WORKSPACE_ROOT = "/paperclip/devflow/ws";
export const DEFAULT_MAX_USD_PER_RUN = 1;
export const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * One directory for every company's BA agent: runs are strictly one at a time and the directory is emptied
 * before and after each run, so no other company's request or repository is ever on disk next to the agent.
 */
export const baWorkspaceDir = (root: string = DEFAULT_WORKSPACE_ROOT) => path.posix.join(root, "ba");

/** Places the agent must not read even though its tools could reach them (Claude Code `Tool(//absolute/**)` rules). */
const DENIED_DIRS = ["/paperclip/instances", "/proc", "/sys", "/etc", "/root", "/home", "/var", "/run", "/boot", "/dev"];
export const denyRules = (): string => DENIED_DIRS.flatMap((d) => ["Read", "Grep", "Glob"].map((t) => `${t}(/${d}/**)`)).join(",");

export type BaAgentSpec = {
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
export function baAgentSpec(opts: { model?: string; maxUsdPerRun?: number; workspaceRoot?: string } = {}): BaAgentSpec {
  const maxUsd = opts.maxUsdPerRun && opts.maxUsdPerRun > 0 ? opts.maxUsdPerRun : DEFAULT_MAX_USD_PER_RUN;
  return {
    name: BA_AGENT_NAME,
    adapterType: "claude_local",
    adapterConfig: {
      cwd: baWorkspaceDir(opts.workspaceRoot),
      model: opts.model || DEFAULT_MODEL,
      engine: "cli",
      maxTurnsPerRun: 60,
      timeoutSec: 900,
      extraArgs: ["--tools", BA_TOOLS, "--disallowedTools", denyRules(), "--max-budget-usd", String(maxUsd)],
    },
    runtimeConfig: { heartbeat: { enabled: false } },
    metadata: { devflowRole: PROMPT_ROLE, devflowPromptVersion: PROMPT_VERSION, devflowPromptHash: PROMPT_HASH },
    instructions: SYSTEM_PROMPT,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
  };
}

type AgentRow = {
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
export function unsafeBaAgentReason(agent: AgentRow, workspaceRoot: string = DEFAULT_WORKSPACE_ROOT): string | null {
  if (agent.status === "paused" || agent.status === "terminated") return "agent_not_runnable";
  if (agent.adapterType !== "claude_local") return "agent_wrong_adapter";
  const cfg = asRecord(agent.adapterConfig);
  if (cfg.engine !== "cli") return "agent_wrong_engine";
  if (cfg.cwd !== baWorkspaceDir(workspaceRoot)) return "agent_wrong_workspace";
  if (cfg.command !== undefined || cfg.chrome === true || cfg.mcpServers !== undefined) return "agent_extra_capability";
  const args = Array.isArray(cfg.extraArgs) ? cfg.extraArgs.map(String) : [];
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  if (args.filter((a) => a === "--tools").length !== 1 || valueOf("--tools") !== BA_TOOLS) return "agent_tools_not_read_only";
  const deny = valueOf("--disallowedTools") ?? "";
  if (!deny.split(",").includes("Read(//paperclip/instances/**)")) return "agent_instance_not_denied";
  const budget = Number(valueOf("--max-budget-usd"));
  if (!Number.isFinite(budget) || budget <= 0) return "agent_no_budget";
  const meta = asRecord(agent.metadata);
  if (meta.devflowPromptHash !== PROMPT_HASH) return "agent_prompt_outdated";
  return null;
}

/** The company's BA agent, or null when the setup script has not run for it. */
export async function findBaAgent(db: Db, companyId: string) {
  const [row] = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), sql`${agents.metadata}->>'devflowRole' = ${PROMPT_ROLE}`))
    .limit(1);
  return row ?? null;
}
