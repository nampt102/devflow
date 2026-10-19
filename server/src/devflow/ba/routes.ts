import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { staffUser } from "../staff.js";
import { baAgentSpec, DEFAULT_MAX_USD_PER_RUN, DEFAULT_MODEL, findBaAgent, unsafeBaAgentReason, DEFAULT_WORKSPACE_ROOT } from "./agent.js";
import { baDecisionSchema, baReviewService } from "./review-service.js";

type Env = Record<string, string | undefined>;
type ReviewCase = (input: any) => Promise<unknown>;

/** The agent configuration DevFlow expects, as the instance is configured. */
export function specFromEnv(env: Env) {
  return baAgentSpec({
    model: env.DEVFLOW_BA_MODEL || DEFAULT_MODEL,
    maxUsdPerRun: Number(env.DEVFLOW_BA_MAX_USD_PER_RUN) || DEFAULT_MAX_USD_PER_RUN,
    workspaceRoot: env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  });
}

/** Staff routes for the BA Spec stage: agent setup, and the review of BA specs. */
export function baRoutes(db: Db, deps: { reviewCase: ReviewCase }, env: Env = process.env) {
  const router = Router();
  const review = baReviewService(db, deps);

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

  router.get("/companies/:companyId/devflow/ba-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review BA specs");
    res.json(await review.queue(companyId));
  });

  router.get("/companies/:companyId/devflow/ba-count", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review BA specs");
    res.json(await review.count(companyId));
  });

  router.get("/companies/:companyId/devflow/ba-cases/:caseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "review BA specs");
    const found = await review.detail(companyId, req.params.caseId as string);
    if (!found) throw notFound("Request not found");
    res.json(found);
  });

  router.post("/companies/:companyId/devflow/ba-cases/:caseId/decision", validate(baDecisionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = staffUser(req, companyId, "review BA specs");
    res.json(await review.decide({ companyId, caseId: req.params.caseId as string, userId, body: req.body }));
  });

  return router;
}
