import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../../middleware/validate.js";
import { staffUser } from "../staff.js";
import { createSystemSchema, systemsService, updateSystemSchema, type SecretDeps } from "./service.js";

/** Staff manage the catalog of systems (repositories) their requests can be about. */
export function systemsRoutes(db: Db, secrets?: SecretDeps) {
  const router = Router();
  const svc = systemsService(db, secrets);

  router.get("/companies/:companyId/devflow/systems", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "manage systems");
    res.json({ items: await svc.list(companyId) });
  });

  router.post("/companies/:companyId/devflow/systems", validate(createSystemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = staffUser(req, companyId, "manage systems");
    res.status(201).json(await svc.create(companyId, userId, req.body));
  });

  router.patch("/companies/:companyId/devflow/systems/:systemId", validate(updateSystemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = staffUser(req, companyId, "manage systems");
    res.json(await svc.update(companyId, userId, req.params.systemId as string, req.body));
  });

  return router;
}
