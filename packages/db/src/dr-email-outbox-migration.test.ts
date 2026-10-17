/**
 * DevFlow email outbox (migration 0358, openspec/decisions/0016): one row per pipeline event, company
 * isolation by composite foreign keys, and the checks that keep the record honest.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0358_devflow_email_outbox.sql", import.meta.url), "utf8");

describe("migration 0358 file", () => {
  it("only creates the outbox table and its constraints", () => {
    const tables = [...migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(tables).toEqual(["dr_email_outbox"]);
    expect(migrationSql).not.toMatch(/DROP |ALTER TABLE "(?!dr_email_outbox)/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_email_outbox", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;

  type Tenant = { companyId: string; caseId: string; eventId: string; requesterId: string };
  const prefix = () => randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");

  async function tenant(label: string): Promise<Tenant> {
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES (${label}, ${prefix()}) RETURNING id`;
    const [pipeline] = await sql`INSERT INTO pipelines (company_id, key, name) VALUES (${company.id}, 'dev-request', 'Dev Request') RETURNING id`;
    const [stage] = await sql`INSERT INTO pipeline_stages (pipeline_id, key, name, kind, position)
                              VALUES (${pipeline.id}, 'triage', 'Triage', 'working', 100) RETURNING id`;
    const [kase] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
                             VALUES (${company.id}, ${pipeline.id}, ${stage.id}, ${randomUUID()}, ${`case ${label}`}) RETURNING id`;
    const [event] = await sql`INSERT INTO pipeline_case_events (company_id, case_id, type, actor_type, to_stage_id)
                              VALUES (${company.id}, ${kase.id}, 'ingested', 'system', ${stage.id}) RETURNING id`;
    const userId = `user-${randomUUID()}`;
    await sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
              VALUES (${userId}, 'Người dùng', ${`${userId}@example.test`}, false, now(), now())`;
    const [requester] = await sql`INSERT INTO dr_requesters (company_id, user_id) VALUES (${company.id}, ${userId}) RETURNING id`;
    return { companyId: company.id, caseId: kase.id, eventId: event.id, requesterId: requester.id };
  }

  const row = (t: Tenant, over: Record<string, unknown> = {}) => {
    const v = {
      eventId: t.eventId, requesterId: t.requesterId, caseId: t.caseId, companyId: t.companyId, to: "a@example.test",
      subject: "Chủ đề", body: "Nội dung", status: "pending", sentAt: null as Date | null, ...over,
    };
    return sql`INSERT INTO dr_email_outbox (company_id, case_id, event_id, requester_id, to_email, subject, body, status, sent_at)
               VALUES (${v.companyId as string}, ${v.caseId as string}, ${v.eventId as string}, ${v.requesterId as string}, ${v.to as string},
                       ${v.subject as string}, ${v.body as string}, ${v.status as string}, ${v.sentAt}) RETURNING id`;
  };

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("devflow-outbox-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 4 });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("stores a pending row with defaults and rejects a second row for the same event", async () => {
    const t = await tenant("Outbox A");
    const [r] = await row(t);
    const [saved] = await sql`SELECT status, attempts, last_error, sent_at FROM dr_email_outbox WHERE id = ${r.id}`;
    expect(saved).toMatchObject({ status: "pending", attempts: 0, last_error: null, sent_at: null });
    await expect(row(t)).rejects.toThrow(/dr_email_outbox_event_uq/);
  });

  it("allows only the four statuses and ties sent_at to status sent", async () => {
    const t = await tenant("Outbox B");
    await expect(row(t, { status: "queued" })).rejects.toThrow(/dr_email_outbox_status_check/);
    await expect(row(t, { status: "sent" })).rejects.toThrow(/dr_email_outbox_sent_check/);
    await expect(row(t, { status: "pending", sentAt: new Date() })).rejects.toThrow(/dr_email_outbox_sent_check/);
    await row(t, { status: "sent", sentAt: new Date() });
  });

  it("bounds the stored text", async () => {
    const t = await tenant("Outbox C");
    await expect(row(t, { subject: "x".repeat(301) })).rejects.toThrow(/dr_email_outbox_size_check/);
    await expect(row(t, { body: "x".repeat(5001) })).rejects.toThrow(/dr_email_outbox_size_check/);
  });

  it("rejects a requester or a case from another company", async () => {
    const a = await tenant("Outbox D1");
    const b = await tenant("Outbox D2");
    await expect(row(a, { requesterId: b.requesterId })).rejects.toThrow(/dr_email_outbox_requester_company_fk/);
    await expect(row(a, { caseId: b.caseId })).rejects.toThrow(/dr_email_outbox_case_company_fk/);
  });

  it("is removed with its event, its case, or its requester", async () => {
    for (const drop of [
      (t: Tenant) => sql`DELETE FROM pipeline_case_events WHERE id = ${t.eventId}`,
      (t: Tenant) => sql`DELETE FROM pipeline_cases WHERE id = ${t.caseId}`,
      (t: Tenant) => sql`DELETE FROM dr_requesters WHERE id = ${t.requesterId}`,
    ]) {
      const t = await tenant("Outbox E");
      await row(t);
      await drop(t);
      expect(await sql`SELECT 1 FROM dr_email_outbox WHERE company_id = ${t.companyId}`).toHaveLength(0);
    }
  });
});
