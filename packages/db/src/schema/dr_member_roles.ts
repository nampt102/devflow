import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Business roles of a company's staff (openspec change add-approver-roles, ADR 0023). One row per
// (company, user, role), so a person can hold several roles. The role list is closed by a CHECK; adding a
// role is a small migration. There is no foreign key to the user table (Paperclip owns it); the service
// checks that the user is an active member of the company when a role is granted.
export const drMemberRoles = pgTable(
  "dr_member_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserRoleUq: uniqueIndex("dr_member_roles_company_user_role_uq").on(table.companyId, table.userId, table.role),
    companyUserIdx: index("dr_member_roles_company_user_idx").on(table.companyId, table.userId),
    roleCheck: check("dr_member_roles_role_check", sql`${table.role} in ('ba', 'tech_lead')`),
  }),
);
