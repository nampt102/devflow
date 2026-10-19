import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { staffUser } from "../staff.js";
import { baAgentSpec, DEFAULT_MAX_USD_PER_RUN, DEFAULT_MODEL, findBaAgent, unsafeBaAgentReason, DEFAULT_WORKSPACE_ROOT } from "./agent.js";

type Env = Record<string, string | undefined>;

/** The agent configuration DevFlow expects, as the instance is configured. */
export function specFromEnv(env: Env) {
  return baAgentSpec({
    model: env.DEVFLOW_BA_MODEL || DEFAULT_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_BA_MAX_USD_PER_RUN) || DEFAULT_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the BA Spec stage. */
export function baRoutes(db: Db, env: Env = process.env) {
  const router = Router();

  // What the BA agent must look like and whether this company's agent matches (used by scripts/devflow/setup-ba-agent.mjs).
  router.get("/companies/:companyId/devflow/ba-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see the BA agent setup");
    const spec = specFromEnv(env);
    const agent = await findBaAgent(db, companyId);
    res.json({
      spec,
      agent: agent
        ? { id: agent.id, name: agent.name, status: agent.status, problem: unsafeBaAgentReason(agent, env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT) }
        : null,
    });
  });

  return router;
}
