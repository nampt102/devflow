import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";

// The systems a company's requests can be about, and which of them a request was assigned (openspec change
// add-ba-spec-stage, ADR 0020). A system is one GitHub repository the BA agent may read. Same isolation rule
// as the other dr_* tables: composite (id, company_id) foreign keys.
export const drSystems = pgTable(
  "dr_systems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    docsPath: text("docs_path").notNull().default("docs"),
    // company_secrets.id of the read-only token; null for a public repository. Same company is checked by the service.
    tokenSecretId: uuid("token_secret_id"),
    // agent Dev (change add-dev-stage): per-system switch, separate write token, optional test command, extra forbidden paths
    devEnabled: boolean("dev_enabled").notNull().default(false),
    writeTokenSecretId: uuid("write_token_secret_id"),
    testCommand: text("test_command"),
    forbiddenPaths: text("forbidden_paths").array().notNull().default(sql`'{}'::text[]`),
    // the default branch has no branch protection (e.g. private repo on the free GitHub plan) and the project owner accepts that
    allowUnprotected: boolean("allow_unprotected").notNull().default(false),
    // a system is switched off, never deleted, so old agent outputs still name it
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idCompanyUq: uniqueIndex("dr_systems_id_company_uq").on(table.id, table.companyId),
    companyKeyUq: uniqueIndex("dr_systems_company_key_uq").on(table.companyId, table.key),
    keyCheck: check("dr_systems_key_check", sql`${table.key} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
    repoCheck: check("dr_systems_repo_check", sql`${table.repoUrl} ~ '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'`),
    docsCheck: check("dr_systems_docs_check", sql`${table.docsPath} !~ '(^/|\\.\\.)'`),
    testCommandCheck: check("dr_systems_test_command_check", sql`${table.testCommand} is null or char_length(${table.testCommand}) between 1 and 500`),
    forbiddenPathsCheck: check("dr_systems_forbidden_paths_check", sql`cardinality(${table.forbiddenPaths}) <= 50`),
    devTokenCheck: check("dr_systems_dev_token_check", sql`not ${table.devEnabled} or ${table.writeTokenSecretId} is not null`),
    sizeCheck: check(
      "dr_systems_size_check",
      sql`char_length(${table.name}) between 1 and 200 and char_length(${table.description}) <= 2000 and char_length(${table.defaultBranch}) between 1 and 200 and char_length(${table.docsPath}) <= 200`,
    ),
  }),
);

/** Which systems a request was assigned at Triage review (and possibly changed at BA review). */
export const drRequestSystems = pgTable(
  "dr_request_systems",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    systemId: uuid("system_id").notNull(),
    assignedByUserId: text("assigned_by_user_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: "dr_request_systems_pk", columns: [table.caseId, table.systemId] }),
    caseFk: foreignKey({
      name: "dr_request_systems_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    systemFk: foreignKey({
      name: "dr_request_systems_system_company_fk",
      columns: [table.systemId, table.companyId],
      foreignColumns: [drSystems.id, drSystems.companyId],
    }).onDelete("cascade"),
    companySystemIdx: index("dr_request_systems_company_idx").on(table.companyId, table.systemId),
  }),
);
