import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

// One-time links that let a business user become a requester (openspec/decisions/0011).
// The token is the credential: only its SHA-256 is stored, and email is never a security check.
// No foreign key to dr_requesters on purpose: deleting a user or requester must not be blocked by
// (or erase) the invite record.
export const drRequesterInvites = pgTable(
  "dr_requester_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    createdByUserId: text("created_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: text("accepted_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("dr_requester_invites_token_hash_uq").on(table.tokenHash),
    companyCreatedIdx: index("dr_requester_invites_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
