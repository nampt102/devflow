import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authAccounts, authUsers } from "@paperclipai/db";
import { conflict } from "../errors.js";

// Credential accounts written directly, so people can be added while public sign-up is closed
// (ADR 0012). Shared by registration through an invitation and by the instance admin endpoints.

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** 18 random bytes as base64url: 24 characters, 144 bits. */
export const generatePassword = () => randomBytes(18).toString("base64url");

export const newAccountId = () => randomBytes(24).toString("base64url");

/**
 * Serializes writers of the same email and refuses a taken one (compared case-insensitively). The lock is
 * needed because `user.email` has no unique index: better-auth only checks in code. Call inside a transaction.
 */
export async function assertEmailFree(tx: Db, email: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dr-register:${email}`}))`);
  const [taken] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .limit(1);
  if (taken) throw conflict("An account with this email already exists", { code: "account_exists" });
}

/** Inserts `user` and its `credential` account (what better-auth's own sign-up writes). */
export async function insertCredentialAccount(
  tx: Db,
  input: { userId: string; name: string; email: string; passwordHash: string },
) {
  const now = new Date();
  await tx.insert(authUsers).values({
    id: input.userId,
    name: input.name,
    email: input.email,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(authAccounts).values({
    id: newAccountId(),
    issuer: "local:credential",
    accountId: input.userId,
    providerId: "credential",
    userId: input.userId,
    password: input.passwordHash,
    createdAt: now,
    updatedAt: now,
  });
}
