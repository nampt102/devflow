import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { pipelineCases } from "./pipeline_cases.js";

// Structured agent proposals and the human changes to them (openspec/decisions/0013).
// Same isolation rule as the other dr_* tables: composite (id, company_id) foreign keys.

/**
 * One proposal from an agent for one stage of a request: machine-readable `data` plus a readable
 * `comment_text`. Prompts live as versioned files in the repo, so only role, version and hash are stored.
 */
export const drAgentOutputs = pgTable(
  "dr_agent_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    stageKey: text("stage_key").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    promptRole: text("prompt_role").notNull(),
    promptVersion: text("prompt_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    commentText: text("comment_text").notNull(),
    status: text("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: text("decided_by_user_id"),
  },
  (table) => ({
    caseFk: foreignKey({
      name: "dr_agent_outputs_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    idCompanyUq: uniqueIndex("dr_agent_outputs_id_company_uq").on(table.id, table.companyId),
    // a stage of a request has at most one live proposal; older ones become superseded
    oneProposedUq: uniqueIndex("dr_agent_outputs_one_proposed_uq")
      .on(table.caseId, table.stageKey)
      .where(sql`${table.status} = 'proposed'`),
    caseStageIdx: index("dr_agent_outputs_case_stage_idx").on(table.companyId, table.caseId, table.stageKey, table.createdAt),
    promptIdx: index("dr_agent_outputs_prompt_idx").on(table.companyId, table.promptRole, table.promptVersion),
    statusCheck: check(
      "dr_agent_outputs_status_check",
      sql`${table.status} in ('proposed', 'accepted', 'overridden', 'superseded')`,
    ),
    // named size limits: structured data is a small object, the comment a short readable text
    dataCheck: check(
      "dr_agent_outputs_data_check",
      sql`jsonb_typeof(${table.data}) = 'object' and octet_length(${table.data}::text) <= 65536`,
    ),
    commentCheck: check("dr_agent_outputs_comment_check", sql`char_length(${table.commentText}) <= 20000`),
    namesCheck: check(
      "dr_agent_outputs_names_check",
      sql`${table.stageKey} <> '' and ${table.promptRole} <> '' and ${table.promptVersion} <> '' and ${table.promptHash} <> ''`,
    ),
    // a proposal that is still open has no decision; accepted or overridden ones record who decided and when
    decisionCheck: check(
      "dr_agent_outputs_decision_check",
      sql`(${table.status} <> 'proposed' or ${table.decidedAt} is null)
        and (${table.status} not in ('accepted', 'overridden') or (${table.decidedAt} is not null and ${table.decidedByUserId} is not null))`,
    ),
  }),
);

/** Only the differences: one row per field a human changed in an agent proposal. Basis of the override rate. */
export const drOverrides = pgTable(
  "dr_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    outputId: uuid("output_id").notNull(),
    stageKey: text("stage_key").notNull(),
    field: text("field").notNull(),
    agentValue: jsonb("agent_value"),
    finalValue: jsonb("final_value"),
    actorUserId: text("actor_user_id").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseFk: foreignKey({
      name: "dr_overrides_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    outputFk: foreignKey({
      name: "dr_overrides_output_company_fk",
      columns: [table.outputId, table.companyId],
      foreignColumns: [drAgentOutputs.id, drAgentOutputs.companyId],
    }).onDelete("cascade"),
    outputFieldUq: uniqueIndex("dr_overrides_output_field_uq").on(table.outputId, table.field),
    companyCreatedIdx: index("dr_overrides_company_created_idx").on(table.companyId, table.createdAt),
    companyFieldIdx: index("dr_overrides_company_stage_field_idx").on(table.companyId, table.stageKey, table.field),
    fieldCheck: check("dr_overrides_field_check", sql`char_length(${table.field}) between 1 and 200`),
    reasonCheck: check("dr_overrides_reason_check", sql`${table.reason} is null or char_length(${table.reason}) <= 4000`),
    changedCheck: check("dr_overrides_changed_check", sql`${table.agentValue} is distinct from ${table.finalValue}`),
  }),
);
