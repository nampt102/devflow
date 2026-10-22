import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { stageMetricsService } from "../agent-stage/metrics.js";
import { staffUser, staffViewer } from "../staff.js";
import { DEFAULT_DEV_MAX_USD_PER_RUN, DEFAULT_DEV_MODEL, devAgentProblem, devAgentSpec } from "./agent.js";
import { CODE_REVIEW_STAGE, DEV_STAGE } from "./dev-service.js";
import { codeDecisionSchema, codeReviewService, type CodeReviewDeps } from "./review-service.js";

type Env = Record<string, string | undefined>;

/** The Dev agent configuration DevFlow expects, as the instance is configured. */
export function devSpecFromEnv(env: Env) {
  return devAgentSpec({
    model: env.DEVFLOW_DEV_MODEL || DEFAULT_DEV_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_DEV_MAX_USD_PER_RUN) || DEFAULT_DEV_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the Dev stage: agent setup, and the review of the Dev agent's work. */
export function devRoutes(db: Db, deps: CodeReviewDeps, env: Env = process.env) {
  const router = Router();
  const review = codeReviewService(db, deps);
  const metrics = stageMetricsService(db, { role: "dev", stageKey: DEV_STAGE, reviewStageKey: CODE_REVIEW_STAGE });

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

  router.get("/companies/:companyId/devflow/code-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review code");
    res.json(await review.queue(companyId));
  });

  router.get("/companies/:companyId/devflow/code-count", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review code");
    res.json(await review.count(companyId));
  });

  router.get("/companies/:companyId/devflow/code-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see Dev metrics");
    const days = Math.min(Math.max(Math.trunc(Number(req.query.days)) || 30, 1), 365);
    res.json(await metrics.metrics(companyId, days));
  });

  router.get("/companies/:companyId/devflow/code-cases/:caseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewer = staffViewer(req, companyId, "review code");
    const found = await review.detail(companyId, req.params.caseId as string, viewer);
    if (!found) throw notFound("Request not found");
    res.json(found);
  });

  router.post("/companies/:companyId/devflow/code-cases/:caseId/decision", validate(codeDecisionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { userId, instanceAdmin } = staffViewer(req, companyId, "review code");
    res.json(await review.decide({ companyId, caseId: req.params.caseId as string, userId, instanceAdmin, body: req.body }));
  });

  return router;
}
