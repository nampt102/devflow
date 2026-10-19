import type { Request } from "express";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "../routes/authz.js";

/** Staff-only: a signed-in board user with access to the company. Requesters and agent keys are refused. */
export function staffUser(req: Request, companyId: string, what = "review requests"): string {
  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.type !== "board") throw forbidden(`Only board users can ${what}`);
  if (!hasCompanyAccess(req, companyId)) throw notFound("Not found");
  assertCompanyAccess(req, companyId);
  return req.actor.userId ?? "board";
}
