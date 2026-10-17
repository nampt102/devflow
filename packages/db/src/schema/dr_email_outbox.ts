import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { drRequesters } from "./dr_requests.js";
import { pipelineCaseEvents } from "./pipeline_case_events.js";
import { pipelineCases } from "./pipeline_cases.js";

// Status-change emails to requesters (openspec/decisions/0016). One row per pipeline event: the unique
// `event_id` makes enqueueing idempotent, so a restart or a second server instance cannot queue it twice.
// Subject and body are written when queued, so what was sent is what was recorded. Same isolation rule as
// the other dr_* tables: composite (id, company_id) foreign keys.
export const drEmailOutbox = pgTable(
  "dr_email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    eventId: uuid("event_id").notNull().references(() => pipelineCaseEvents.id, { onDelete: "cascade" }),
    requesterId: uuid("requester_id").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    // skipped: the event was seen but needs no email (same status label, or the requester is deactivated)
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    // error kind only (never the message body or server text)
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseFk: foreignKey({
      name: "dr_email_outbox_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    requesterFk: foreignKey({
      name: "dr_email_outbox_requester_company_fk",
      columns: [table.requesterId, table.companyId],
      foreignColumns: [drRequesters.id, drRequesters.companyId],
    }).onDelete("cascade"),
    eventUq: uniqueIndex("dr_email_outbox_event_uq").on(table.eventId),
    pendingIdx: index("dr_email_outbox_pending_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
    companyCaseIdx: index("dr_email_outbox_company_case_idx").on(table.companyId, table.caseId, table.createdAt),
    statusCheck: check("dr_email_outbox_status_check", sql`${table.status} in ('pending', 'sent', 'failed', 'skipped')`),
    sizeCheck: check(
      "dr_email_outbox_size_check",
      sql`char_length(${table.subject}) <= 300 and char_length(${table.body}) <= 5000 and char_length(${table.toEmail}) <= 320 and (${table.lastError} is null or char_length(${table.lastError}) <= 200)`,
    ),
    sentCheck: check("dr_email_outbox_sent_check", sql`(${table.status} = 'sent') = (${table.sentAt} is not null)`),
    attemptsCheck: check("dr_email_outbox_attempts_check", sql`${table.attempts} >= 0`),
  }),
);
