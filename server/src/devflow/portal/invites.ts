import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "@paperclipai/db";
import { drRequesterInvites, drRequesters } from "@paperclipai/db";
import { HttpError, conflict, notFound } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { assertEmailFree, insertCredentialAccount, newAccountId, normalizeEmail } from "../accounts.js";

export const INVITE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");
// 32 random bytes, base64url: 43 characters
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";
export type InviteDto = {
  id: string;
  label: string | null;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

const gone = (message: string, code: string) => new HttpError(410, message, { code });

function statusOf(row: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }): InviteStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

const toDto = (row: typeof drRequesterInvites.$inferSelect): InviteDto => ({
  id: row.id,
  label: row.label,
  status: statusOf(row),
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  acceptedAt: row.acceptedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

function assertUsable(invite: typeof drRequesterInvites.$inferSelect) {
  if (invite.revokedAt) throw gone("This invitation was revoked", "invite_revoked");
  if (invite.acceptedAt) throw gone("This invitation was already used", "invite_used");
  if (invite.expiresAt.getTime() <= Date.now()) throw gone("This invitation has expired", "invite_expired");
}

export type RegisterInput = { token: string; name: string; email: string; password: string };

export function portalInvites(db: Db, deps: { hashPassword: (password: string) => Promise<string> } = { hashPassword }) {
  /** One conditional UPDATE decides who gets the invitation; the caller runs it inside its transaction. */
  const claim = (tx: Db, inviteId: string, userId: string) =>
    tx
      .update(drRequesterInvites)
      .set({ acceptedAt: new Date(), acceptedByUserId: userId })
      .where(
        and(
          eq(drRequesterInvites.id, inviteId),
          isNull(drRequesterInvites.acceptedAt),
          isNull(drRequesterInvites.revokedAt),
          gt(drRequesterInvites.expiresAt, new Date()),
        ),
      )
      .returning({ id: drRequesterInvites.id });

  return {
    /** The token is returned once and never stored: only its hash is. */
    async create(companyId: string, createdByUserId: string, input: { label?: string | null } = {}) {
      const token = randomBytes(32).toString("base64url");
      const [row] = await db
        .insert(drRequesterInvites)
        .values({
          companyId,
          tokenHash: hashInviteToken(token),
          label: input.label?.trim() || null,
          createdByUserId,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS),
        })
        .returning();
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: createdByUserId,
        action: "portal.invite_created",
        entityType: "dr_requester_invite",
        entityId: row.id,
        details: { label: row.label },
      });
      return { ...toDto(row), token, path: `/portal/invite/${token}` };
    },

    async list(companyId: string): Promise<InviteDto[]> {
      const rows = await db
        .select()
        .from(drRequesterInvites)
        .where(eq(drRequesterInvites.companyId, companyId))
        .orderBy(desc(drRequesterInvites.createdAt))
        .limit(200);
      return rows.map(toDto);
    },

    async revoke(companyId: string, actorUserId: string, inviteId: string): Promise<InviteDto> {
      const [row] = await db
        .update(drRequesterInvites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(drRequesterInvites.id, inviteId),
            eq(drRequesterInvites.companyId, companyId),
            isNull(drRequesterInvites.acceptedAt),
            isNull(drRequesterInvites.revokedAt),
          ),
        )
        .returning();
      if (!row) throw notFound("Invitation not found or no longer pending");
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "portal.invite_revoked",
        entityType: "dr_requester_invite",
        entityId: row.id,
      });
      return toDto(row);
    },

    /**
     * Binds the invite to the signed-in user, never to an email. The conditional UPDATE runs in the same
     * transaction that creates the requester, so a link works exactly once.
     */
    async accept(userId: string, token: string) {
      return db.transaction(async (tx) => {
        const [invite] = await tx
          .select()
          .from(drRequesterInvites)
          .where(eq(drRequesterInvites.tokenHash, hashInviteToken(token)));
        if (!invite) throw notFound("Invalid invitation link");
        // The person who already used this link (e.g. through register, or reopening the page) is not an
        // error: report the requester they became. Anyone else still gets 410 below.
        if (invite.acceptedAt && invite.acceptedByUserId === userId) {
          const [mine] = await tx
            .select({ id: drRequesters.id })
            .from(drRequesters)
            .where(and(eq(drRequesters.companyId, invite.companyId), eq(drRequesters.userId, userId), isNull(drRequesters.deactivatedAt)));
          if (mine) return { companyId: invite.companyId, requesterId: mine.id };
        }
        assertUsable(invite);

        const [existing] = await tx
          .select()
          .from(drRequesters)
          .where(and(eq(drRequesters.companyId, invite.companyId), eq(drRequesters.userId, userId)));
        if (existing && !existing.deactivatedAt) {
          throw conflict("You already have portal access in this company", { code: "already_requester" });
        }

        const [claimed] = await claim(tx as unknown as Db, invite.id, userId);
        if (!claimed) throw gone("This invitation is no longer valid", "invite_unavailable");

        let requesterId: string;
        if (existing) {
          await tx.update(drRequesters).set({ deactivatedAt: null, updatedAt: new Date() }).where(eq(drRequesters.id, existing.id));
          requesterId = existing.id;
        } else {
          const [created] = await tx
            .insert(drRequesters)
            .values({ companyId: invite.companyId, userId })
            .returning({ id: drRequesters.id });
          requesterId = created.id;
        }
        await logActivity(tx as unknown as Db, {
          companyId: invite.companyId,
          actorType: "user",
          actorId: userId,
          action: "portal.invite_accepted",
          entityType: "dr_requester_invite",
          entityId: invite.id,
          details: { requesterId },
        });
        return { companyId: invite.companyId, requesterId };
      });
    },

    /**
     * Creates the account and the requester in one transaction, so people can join while public sign-up is
     * closed. Order matters: the invite is checked first (cheap) so a made-up token never costs a password hash,
     * and the hash runs outside the transaction. Email is a per-email advisory lock because `user.email` has
     * no unique index. An existing email gets 409 and the invite stays untouched.
     */
    async register(input: RegisterInput) {
      const [invite] = await db
        .select()
        .from(drRequesterInvites)
        .where(eq(drRequesterInvites.tokenHash, hashInviteToken(input.token)));
      if (!invite) throw notFound("Invalid invitation link");
      assertUsable(invite);

      const email = normalizeEmail(input.email);
      const name = input.name.trim();
      const passwordHash = await deps.hashPassword(input.password);
      const userId = newAccountId();

      return db.transaction(async (tx) => {
        await assertEmailFree(tx as unknown as Db, email);
        await insertCredentialAccount(tx as unknown as Db, { userId, name, email, passwordHash });
        // losing the race rolls the whole transaction back, including the new user
        const [claimed] = await claim(tx as unknown as Db, invite.id, userId);
        if (!claimed) throw gone("This invitation is no longer valid", "invite_unavailable");
        const [requester] = await tx
          .insert(drRequesters)
          .values({ companyId: invite.companyId, userId })
          .returning({ id: drRequesters.id });
        await logActivity(tx as unknown as Db, {
          companyId: invite.companyId,
          actorType: "user",
          actorId: userId,
          action: "portal.invite_registered",
          entityType: "dr_requester_invite",
          entityId: invite.id,
          details: { requesterId: requester.id },
        });
        return { companyId: invite.companyId, requesterId: requester.id };
      });
    },
  };
}
