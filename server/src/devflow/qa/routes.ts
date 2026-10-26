import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { stageMetricsService } from "../agent-stage/metrics.js";
import { staffUser, staffViewer } from "../staff.js";
import { DEFAULT_QA_MAX_USD_PER_RUN, DEFAULT_QA_MODEL, qaAgentProblem, qaAgentSpec } from "./agent.js";
import { QA_SIGNOFF_STAGE, QA_STAGE } from "./qa-service.js";
import { qaDecisionSchema, qaReviewService, type QaReviewDeps } from "./review-service.js";

type Env = Record<string, string | undefined>;

/** The QA agent configuration DevFlow expects, as the instance is configured. */
export function qaSpecFromEnv(env: Env) {
  return qaAgentSpec({
    model: env.DEVFLOW_QA_MODEL || DEFAULT_QA_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_QA_MAX_USD_PER_RUN) || DEFAULT_QA_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the QA stage: agent setup, and the QA sign-off. */
export function qaRoutes(db: Db, deps: QaReviewDeps, env: Env = process.env) {
  const router = Router();
  const review = qaReviewService(db, deps);
  const metrics = stageMetricsService(db, { role: "qa", stageKey: QA_STAGE, reviewStageKey: QA_SIGNOFF_STAGE });

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

  router.get("/companies/:companyId/devflow/qa-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "sign off QA");
    res.json(await review.queue(companyId));
  });

  router.get("/companies/:companyId/devflow/qa-count", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "sign off QA");
    res.json(await review.count(companyId));
  });

  router.get("/companies/:companyId/devflow/qa-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see QA metrics");
    const days = Math.min(Math.max(Math.trunc(Number(req.query.days)) || 30, 1), 365);
    res.json({ ...(await metrics.metrics(companyId, days)), recommendation: await review.recommendationAgreement(companyId, days) });
  });

  router.get("/companies/:companyId/devflow/qa-cases/:caseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewer = staffViewer(req, companyId, "sign off QA");
    const found = await review.detail(companyId, req.params.caseId as string, viewer);
    if (!found) throw notFound("Request not found");
    res.json(found);
  });

  router.post("/companies/:companyId/devflow/qa-cases/:caseId/decision", validate(qaDecisionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { userId, instanceAdmin } = staffViewer(req, companyId, "sign off QA");
    res.json(await review.decide({ companyId, caseId: req.params.caseId as string, userId, instanceAdmin, body: req.body }));
  });

  return router;
}
