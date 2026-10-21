import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { staffUser } from "../staff.js";
import { DEFAULT_DEV_MAX_USD_PER_RUN, DEFAULT_DEV_MODEL, devAgentProblem, devAgentSpec } from "./agent.js";

type Env = Record<string, string | undefined>;

/** The Dev agent configuration DevFlow expects, as the instance is configured. */
export function devSpecFromEnv(env: Env) {
  return devAgentSpec({
    model: env.DEVFLOW_DEV_MODEL || DEFAULT_DEV_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_DEV_MAX_USD_PER_RUN) || DEFAULT_DEV_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the Dev stage: agent setup (the Code review routes join in task 4.1). */
export function devRoutes(db: Db, env: Env = process.env) {
  const router = Router();

  // What the Dev agent must look like and whether this company's agent matches (scripts/devflow/setup-dev-agent.mjs).
  router.get("/companies/:companyId/devflow/dev-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see the Dev agent setup");
    const { agent, problem } = await devAgentProblem(db, companyId, env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT);
    res.json({
      spec: devSpecFromEnv(env),
      agent: agent ? { id: agent.id, name: agent.name, status: agent.status, problem } : null,
    });
  });

  return router;
}
