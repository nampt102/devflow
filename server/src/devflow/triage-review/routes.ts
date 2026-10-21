import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { staffUser, staffViewer } from "../staff.js";
import { triageMetricsService } from "./metrics.js";
import { decisionSchema, triageReviewService } from "./service.js";

type ReviewCase = (input: any) => Promise<unknown>;

export function triageReviewRoutes(db: Db, deps: { reviewCase: ReviewCase }) {
  const router = Router();
  const svc = triageReviewService(db, deps);
  const metrics = triageMetricsService(db);

  router.get("/companies/:companyId/devflow/triage-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId);
    res.json(await svc.queue(companyId));
  });

  router.get("/companies/:companyId/devflow/triage-count", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId);
    res.json(await svc.count(companyId));
  });

  router.get("/companies/:companyId/devflow/triage-metrics", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId);
    const days = Math.min(Math.max(Math.trunc(Number(req.query.days)) || 30, 1), 365);
    res.json(await metrics.metrics(companyId, days));
  });

  router.get("/companies/:companyId/devflow/triage-cases/:caseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewer = staffViewer(req, companyId);
    const found = await svc.detail(companyId, req.params.caseId as string, viewer);
    if (!found) throw notFound("Request not found");
    res.json(found);
  });

  router.post("/companies/:companyId/devflow/triage-cases/:caseId/decision", validate(decisionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { userId, instanceAdmin } = staffViewer(req, companyId);
    res.json(await svc.decide({ companyId, caseId: req.params.caseId as string, userId, instanceAdmin, body: req.body }));
  });

  return router;
}
