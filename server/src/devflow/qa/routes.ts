import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { staffUser } from "../staff.js";
import { DEFAULT_QA_MAX_USD_PER_RUN, DEFAULT_QA_MODEL, qaAgentProblem, qaAgentSpec } from "./agent.js";

type Env = Record<string, string | undefined>;

/** The QA agent configuration DevFlow expects, as the instance is configured. */
export function qaSpecFromEnv(env: Env) {
  return qaAgentSpec({
    model: env.DEVFLOW_QA_MODEL || DEFAULT_QA_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_QA_MAX_USD_PER_RUN) || DEFAULT_QA_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the QA stage: agent setup (the sign-off routes join in task 4.1). */
export function qaRoutes(db: Db, env: Env = process.env) {
  const router = Router();

  // What the QA agent must look like and whether this company's agent matches (scripts/devflow/setup-qa-agent.mjs).
  router.get("/companies/:companyId/devflow/qa-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see the QA agent setup");
    const { agent, problem } = await qaAgentProblem(db, companyId, env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT);
    res.json({
      spec: qaSpecFromEnv(env),
      agent: agent ? { id: agent.id, name: agent.name, status: agent.status, problem } : null,
    });
  });

  return router;
}
