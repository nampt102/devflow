import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { stageMetricsService } from "../agent-stage/metrics.js";
import { staffUser } from "../staff.js";
import { DEFAULT_PLAN_MAX_USD_PER_RUN, DEFAULT_PLAN_MODEL, findPlanAgent, planAgentSpec, unsafePlanAgentReason } from "./agent.js";
import { PLAN_REVIEW_STAGE, PLAN_STAGE } from "./plan-service.js";
import { planDecisionSchema, planReviewService } from "./review-service.js";

type Env = Record<string, string | undefined>;
type ReviewCase = (input: any) => Promise<unknown>;

/** The Planner configuration DevFlow expects, as the instance is configured. */
export function planSpecFromEnv(env: Env) {
  return planAgentSpec({
    model: env.DEVFLOW_PLAN_MODEL || DEFAULT_PLAN_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_PLAN_MAX_USD_PER_RUN) || DEFAULT_PLAN_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the Tech Plan stage: agent setup, and the review of technical plans. */
export function planRoutes(db: Db, deps: { reviewCase: ReviewCase }, env: Env = process.env) {
  const router = Router();
  const review = planReviewService(db, deps);
  const metrics = stageMetricsService(db, { role: "plan", stageKey: PLAN_STAGE, reviewStageKey: PLAN_REVIEW_STAGE });

  // What the Planner must look like and whether this company's agent matches (used by scripts/devflow/setup-plan-agent.mjs).
  router.get("/companies/:companyId/devflow/plan-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see the Planner agent setup");
    const agent = await findPlanAgent(db, companyId);
    res.json({
      spec: planSpecFromEnv(env),
      agent: agent
        ? { id: agent.id, name: agent.name, status: agent.status, problem: unsafePlanAgentReason(agent, env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT) }
        : null,
    });
  });

  router.get("/companies/:companyId/devflow/plan-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review technical plans");
    res.json(await review.queue(companyId));
  });

  router.get("/companies/:companyId/devflow/plan-count", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review technical plans");
    res.json(await review.count(companyId));
  });

  router.get("/companies/:companyId/devflow/plan-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see Tech Plan metrics");
    const days = Math.min(Math.max(Math.trunc(Number(req.query.days)) || 30, 1), 365);
    res.json(await metrics.metrics(companyId, days));
  });

  router.get("/companies/:companyId/devflow/plan-cases/:caseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review technical plans");
    const found = await review.detail(companyId, req.params.caseId as string);
    if (!found) throw notFound("Request not found");
    res.json(found);
  });

  router.post("/companies/:companyId/devflow/plan-cases/:caseId/decision", validate(planDecisionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = staffUser(req, companyId, "review technical plans");
    res.json(await review.decide({ companyId, caseId: req.params.caseId as string, userId, body: req.body }));
  });

  return router;
}
