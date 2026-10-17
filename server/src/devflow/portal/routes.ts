import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../../errors.js";
import { pipelineService } from "../../services/pipelines.js";
import { portalService } from "./portal-service.js";
import { requireRequester } from "./requester-guard.js";

// Unknown keys (stageKey, priority, fields...) are stripped: a requester cannot set internal data.
const submitSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(8_000),
  businessImpact: z.string().trim().max(4_000).nullish(),
});

/** /api/portal/*: the only API surface for requesters (openspec/decisions/0011). */
export function portalRoutes(db: Db) {
  const router = Router();
  const service = portalService(db, { ingestCase: (input) => pipelineService(db).ingestCase(input) });
  const guard = requireRequester(db);

  router.get("/portal/me", guard, (_req, res) => {
    const { companyId, requesterId } = res.locals.requester!;
    res.json({ companyId, requesterId });
  });

  router.post("/portal/requests", guard, async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request", parsed.error.flatten());
    res.status(201).json(await service.submit(res.locals.requester!, parsed.data));
  });

  router.get("/portal/requests", guard, async (req, res) => {
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    res.json({
      items: await service.list(res.locals.requester!, {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      }),
    });
  });

  router.get("/portal/requests/:number", guard, async (req, res) => {
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1) throw badRequest("Invalid request number");
    res.json(await service.get(res.locals.requester!, number));
  });

  return router;
}
