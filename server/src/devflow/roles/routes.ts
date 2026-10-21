import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../../middleware/validate.js";
import { staffViewer } from "../staff.js";
import { memberRolesService, setRolesSchema } from "./service.js";

/**
 * Business roles of company staff (BA, Tech Lead). Any staff member can read them (to know who reviews what);
 * only the company owner or an instance admin can change them.
 */
export function memberRolesRoutes(db: Db) {
  const router = Router();
  const svc = memberRolesService(db);

  router.get("/companies/:companyId/devflow/member-roles", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewer = staffViewer(req, companyId, "see member roles");
    res.json(await svc.list(companyId, viewer));
  });

  router.put("/companies/:companyId/devflow/member-roles/:userId", validate(setRolesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = staffViewer(req, companyId, "change member roles");
    res.json(await svc.setRoles(companyId, actor, req.params.userId as string, req.body.roles));
  });

  return router;
}
