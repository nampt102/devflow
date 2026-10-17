import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, notFound, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess, hasCompanyAccess } from "../../routes/authz.js";
import { decisionSchema, triageReviewService } from "./service.js";

type ReviewCase = (input: any) => Promise<unknown>;

/** Staff-only: a signed-in board user with access to the company. Requesters and agent keys are refused. */
function staffUser(req: Request, companyId: string): string {
  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.type !== "board") throw forbidden("Only board users can review triage proposals");
  if (!hasCompanyAccess(req, companyId)) throw notFound("Request not found");
  assertCompanyAccess(req, companyId);
  return req.actor.userId ?? "board";
}

export function triageReviewRoutes(db: Db, deps: { reviewCase: ReviewCase }) {
  const router = Router();
  const svc = triageReviewService(db, deps);

  router.get("/companies/:companyId/devflow/triage-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId);
    res.json(await svc.queue(companyId));
  });

  router.get("/companies/:companyId/devflow/triage-cases/:caseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId);
    const found = await svc.detail(companyId, req.params.caseId as string);
    if (!found) throw notFound("Request not found");
    res.json(found);
  });

  router.post("/companies/:companyId/devflow/triage-cases/:caseId/decision", validate(decisionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = staffUser(req, companyId);
    res.json(await svc.decide({ companyId, caseId: req.params.caseId as string, userId, body: req.body }));
  });

  return router;
}
