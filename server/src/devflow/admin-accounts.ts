import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "@paperclipai/db";
import { authAccounts, authSessions, authUsers, companies } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertInstanceAdmin } from "../routes/authz.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { getHiddenSettings } from "../services/settings-visibility.js";
import { assertEmailFree, generatePassword, insertCredentialAccount, newAccountId, normalizeEmail } from "./accounts.js";

// Instance admin tools to add people and recover passwords while public sign-up is closed (ADR 0012).
// Paperclip has no password reset and its invite pages need an existing account, so both are needed
// before PAPERCLIP_AUTH_DISABLE_SIGN_UP=true is safe.

type Deps = {
  hashPassword: (password: string) => Promise<string>;
  grantCompanyAccess: (tx: Db, userId: string, companyIds: string[], actorUserId: string | null) => Promise<unknown>;
};

const defaultDeps: Deps = {
  hashPassword,
  // accessService on the transaction: its own transaction becomes a savepoint, so granting stays atomic
  grantCompanyAccess: (tx, userId, companyIds, actorUserId) =>
    accessService(tx).setUserCompanyAccess(userId, companyIds, { actorUserId }),
};

export type CreateUserInput = { name: string; email: string; companyIds?: string[]; password?: string };

export function adminAccounts(db: Db, deps: Deps = defaultDeps) {
  return {
    /** Creates a credential account; the server generates the password unless one is supplied. */
    async createUser(actorUserId: string | null, input: CreateUserInput) {
      const email = normalizeEmail(input.email);
      const name = input.name.trim();
      const companyIds = [...new Set(input.companyIds ?? [])];
      if (companyIds.length > 0) {
        const found = await db.select({ id: companies.id }).from(companies).where(inArray(companies.id, companyIds));
        if (found.length !== companyIds.length) throw notFound("Company not found", { code: "company_not_found" });
      }
      const generated = input.password === undefined;
      const password = input.password ?? generatePassword();
      const passwordHash = await deps.hashPassword(password);
      const userId = newAccountId();

      await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        await assertEmailFree(t, email);
        await insertCredentialAccount(t, { userId, name, email, passwordHash });
        if (companyIds.length > 0) await deps.grantCompanyAccess(t, userId, companyIds, actorUserId);
        // activity_log needs a company, so the event is recorded per company the account was added to
        for (const companyId of companyIds) {
          await logActivity(t, {
            companyId,
            actorType: "user",
            actorId: actorUserId ?? "local-board",
            action: "admin.user_created",
            entityType: "user",
            entityId: userId,
            details: { companyIds },
          });
        }
      });
      logger.info({ actorUserId, userId, companyCount: companyIds.length }, "instance admin created a user");
      return { user: { id: userId, name, email }, companyIds, ...(generated ? { password } : {}) };
    },

    /** Replaces the credential password and signs the user out everywhere. */
    async resetPassword(actorUserId: string | null, userId: string, suppliedPassword?: string) {
      const [user] = await db.select({ id: authUsers.id, email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId));
      if (!user) throw notFound("User not found");
      const [account] = await db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")));
      if (!account) throw conflict("This user signs in without a password", { code: "no_credential_account" });

      const generated = suppliedPassword === undefined;
      const password = suppliedPassword ?? generatePassword();
      const passwordHash = await deps.hashPassword(password);
      const revoked = await db.transaction(async (tx) => {
        await tx.update(authAccounts).set({ password: passwordHash, updatedAt: new Date() }).where(eq(authAccounts.id, account.id));
        const gone = await tx.delete(authSessions).where(eq(authSessions.userId, userId)).returning({ id: authSessions.id });
        return gone.length;
      });
      logger.info({ actorUserId, userId, sessionsRevoked: revoked }, "instance admin reset a password");
      return { user: { id: user.id, email: user.email }, sessionsRevoked: revoked, ...(generated ? { password } : {}) };
    },
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(254).email(),
  companyIds: z.array(z.string().uuid()).max(50).optional(),
  password: z.string().min(8).max(128).optional(),
});
const resetSchema = z.object({ password: z.string().min(8).max(128).optional() });

export function adminAccountRoutes(db: Db, deps?: Deps) {
  const router = Router();
  const service = adminAccounts(db, deps);
  const guard = (req: Parameters<typeof assertInstanceAdmin>[0]) => {
    assertInstanceAdmin(req);
    if (getHiddenSettings().has("instance.access")) {
      throw forbidden("Instance user administration is managed by the hosting operator on this instance", {
        code: "settings_operator_managed",
      });
    }
  };

  router.post("/admin/users", async (req, res) => {
    guard(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid user", parsed.error.flatten());
    const result = await service.createUser(req.actor.userId ?? null, parsed.data);
    // a generated password is in this response and nowhere else
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(result);
  });

  router.post("/admin/users/:userId/reset-password", async (req, res) => {
    guard(req);
    const userId = String(req.params.userId);
    if (userId.length < 1 || userId.length > 200) throw notFound("User not found");
    const parsed = resetSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid password", parsed.error.flatten());
    const result = await service.resetPassword(req.actor.userId ?? null, userId, parsed.data.password);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });

  return router;
}
