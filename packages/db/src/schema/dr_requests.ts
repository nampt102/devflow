import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import { assets } from "./assets.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";

// DevFlow Workflow Core (openspec/decisions/0003, 0004). One dr_requests row extends one
// pipeline_cases row with business data. Composite (id, company_id) foreign keys make the
// database itself reject links across companies.

/** Business user allowed to use the intake portal. Not a company member: members can read the board. */
export const drRequesters = pgTable(
  "dr_requesters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("dr_requesters_company_user_uq").on(table.companyId, table.userId),
    idCompanyUq: uniqueIndex("dr_requesters_id_company_uq").on(table.id, table.companyId),
    userIdx: index("dr_requesters_user_idx").on(table.userId),
  }),
);

/** Per-company counter behind the human-readable REQ-n number. */
export const drRequestCounters = pgTable("dr_request_counters", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  lastNumber: integer("last_number").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const drRequests = pgTable(
  "dr_requests",
  {
    caseId: uuid("case_id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    requestNumber: integer("request_number").notNull(),
    requesterId: uuid("requester_id").notNull(),
    description: text("description").notNull(),
    businessImpact: text("business_impact"),
    // Triage outputs: only set once a human approves the triage review.
    classification: text("classification"),
    priority: text("priority"),
    difficulty: text("difficulty"),
    requiresHuman: boolean("requires_human").notNull().default(false),
    requiresHumanReasons: text("requires_human_reasons").array().notNull().default(sql`'{}'::text[]`),
    duplicateOfCaseId: uuid("duplicate_of_case_id"),
    source: text("source").notNull().default("portal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseFk: foreignKey({
      name: "dr_requests_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    requesterFk: foreignKey({
      name: "dr_requests_requester_company_fk",
      columns: [table.requesterId, table.companyId],
      foreignColumns: [drRequesters.id, drRequesters.companyId],
    }),
    duplicateFk: foreignKey({
      name: "dr_requests_duplicate_company_fk",
      columns: [table.duplicateOfCaseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }),
    companyNumberUq: uniqueIndex("dr_requests_company_number_uq").on(table.companyId, table.requestNumber),
    companyRequesterIdx: index("dr_requests_company_requester_idx").on(table.companyId, table.requesterId),
    companyCreatedIdx: index("dr_requests_company_created_idx").on(table.companyId, table.createdAt),
    classificationCheck: check(
      "dr_requests_classification_check",
      sql`${table.classification} is null or ${table.classification} in ('bug', 'feature', 'request')`,
    ),
    priorityCheck: check(
      "dr_requests_priority_check",
      sql`${table.priority} is null or ${table.priority} in ('urgent', 'high', 'medium', 'low')`,
    ),
    difficultyCheck: check(
      "dr_requests_difficulty_check",
      sql`${table.difficulty} is null or ${table.difficulty} in ('easy', 'medium', 'hard')`,
    ),
    sourceCheck: check("dr_requests_source_check", sql`${table.source} in ('portal', 'email', 'manual')`),
    duplicateSelfCheck: check(
      "dr_requests_duplicate_not_self_check",
      sql`${table.duplicateOfCaseId} is null or ${table.duplicateOfCaseId} <> ${table.caseId}`,
    ),
  }),
);

/** Files attached to a request. Storage metadata lives in `assets` (provider, object key, size, sha256). */
export const drAttachments = pgTable(
  "dr_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    uploadedByRequesterId: uuid("uploaded_by_requester_id"),
    uploadedByUserId: text("uploaded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseFk: foreignKey({
      name: "dr_attachments_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    requesterFk: foreignKey({
      name: "dr_attachments_requester_company_fk",
      columns: [table.uploadedByRequesterId, table.companyId],
      foreignColumns: [drRequesters.id, drRequesters.companyId],
    }),
    assetUq: uniqueIndex("dr_attachments_asset_uq").on(table.assetId),
    companyCaseIdx: index("dr_attachments_company_case_idx").on(table.companyId, table.caseId),
  }),
);
