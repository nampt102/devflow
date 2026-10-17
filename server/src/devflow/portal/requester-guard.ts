import type { RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { drRequesters } from "@paperclipai/db";
import { badRequest, forbidden, unauthorized } from "../../errors.js";

/** Identity of a portal caller. companyId and requesterId come from dr_requesters, never from the client. */
export type RequesterContext = { companyId: string; requesterId: string; userId: string };

declare module "express-serve-static-core" {
  interface Locals {
    requester?: RequesterContext;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only a signed-in user with an active dr_requesters row passes. A user who is a requester in several
 * companies must name one (query or body `companyId`); it is matched against the user's own rows.
 */
export function requireRequester(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      const actor = req.actor;
      if (!actor || actor.type !== "board" || actor.source !== "session" || !actor.userId) {
        throw unauthorized("Sign in to use the portal");
      }
      const rows = await db
        .select({ id: drRequesters.id, companyId: drRequesters.companyId })
        .from(drRequesters)
        .where(and(eq(drRequesters.userId, actor.userId), isNull(drRequesters.deactivatedAt)));
      if (rows.length === 0) throw forbidden("Not a requester");

      const asked = (req.query.companyId ?? (req.body as { companyId?: unknown } | undefined)?.companyId) as unknown;
      let row = rows[0];
      if (asked !== undefined) {
        if (typeof asked !== "string" || !UUID.test(asked)) throw badRequest("companyId is invalid");
        const match = rows.find((r) => r.companyId === asked);
        if (!match) throw forbidden("Not a requester in this company");
        row = match;
      } else if (rows.length > 1) {
        throw badRequest("companyId is required");
      }
      res.locals.requester = { companyId: row.companyId, requesterId: row.id, userId: actor.userId };
      next();
    } catch (err) {
      next(err);
    }
  };
}
