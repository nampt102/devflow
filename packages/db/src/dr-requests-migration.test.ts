/**
 * DevFlow Workflow Core tables (migration 0355, openspec/decisions/0004).
 * The point of the composite (id, company_id) foreign keys is that the database itself refuses to
 * link a request, requester, duplicate or attachment across companies, whatever the app code does.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drAttachments, drRequesters, drRequests } from "./schema/dr_requests.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0355_devflow_requests.sql", import.meta.url), "utf8");

describe("dr_requests schema and migration file", () => {
  it("declares company-scoped composite foreign keys", () => {
    const names = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table).foreignKeys.map((fk) => fk.getName());
    expect(names(drRequests)).toEqual(
      expect.arrayContaining([
        "dr_requests_case_company_fk",
        "dr_requests_requester_company_fk",
        "dr_requests_duplicate_company_fk",
      ]),
    );
    expect(names(drAttachments)).toEqual(
      expect.arrayContaining(["dr_attachments_case_company_fk", "dr_attachments_requester_company_fk"]),
    );
    expect(getTableConfig(drRequesters).indexes.map((i) => i.config.name)).toContain("dr_requesters_id_company_uq");
  });

  it("creates the unique indexes before the composite foreign keys that need them", () => {
    const at = (needle: string) => {
      const i = migrationSql.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('CREATE UNIQUE INDEX "pipeline_cases_id_company_uq"')).toBeLessThan(at('ADD CONSTRAINT "dr_requests_case_company_fk"'));
    expect(at('CREATE UNIQUE INDEX "dr_requesters_id_company_uq"')).toBeLessThan(at('ADD CONSTRAINT "dr_requests_requester_company_fk"'));
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_requests company isolation", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;

  const prefix = () => randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");

  type Tenant = { companyId: string; userId: string; requesterId: string; caseId: string; assetId: string };

  async function tenant(label: string): Promise<Tenant> {
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES (${label}, ${prefix()}) RETURNING id`;
    const userId = `user-${randomUUID()}`;
    await sql`INSERT INTO "user" (id, name, email, created_at, updated_at)
              VALUES (${userId}, ${label}, ${`${userId}@example.test`}, now(), now())`;
    const [requester] = await sql`INSERT INTO dr_requesters (company_id, user_id) VALUES (${company.id}, ${userId}) RETURNING id`;
    const [pipeline] = await sql`INSERT INTO pipelines (company_id, key, name) VALUES (${company.id}, 'dev-request', 'Dev Request') RETURNING id`;
    const [stage] = await sql`INSERT INTO pipeline_stages (pipeline_id, key, name, kind, position)
                              VALUES (${pipeline.id}, 'triage', 'Triage', 'working', 100) RETURNING id`;
    const [kase] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
                             VALUES (${company.id}, ${pipeline.id}, ${stage.id}, ${randomUUID()}, ${`case ${label}`}) RETURNING id`;
    const [asset] = await sql`INSERT INTO assets (company_id, provider, object_key, content_type, byte_size, sha256)
                              VALUES (${company.id}, 'local_disk', ${randomUUID()}, 'image/png', 1, 'x') RETURNING id`;
    return { companyId: company.id, userId, requesterId: requester.id, caseId: kase.id, assetId: asset.id };
  }

  const insertRequest = (t: { caseId: string; companyId: string; requesterId: string }, n: number, extra: Record<string, unknown> = {}) =>
    sql`INSERT INTO dr_requests (case_id, company_id, request_number, requester_id, description, duplicate_of_case_id, priority)
        VALUES (${t.caseId}, ${t.companyId}, ${n}, ${t.requesterId}, 'need a report',
                ${(extra.duplicateOf as string | undefined) ?? null}, ${(extra.priority as string | undefined) ?? null})`;

  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("devflow-dr-requests-");
    cleanup = database.cleanup;
    sql = postgres(database.connectionString, { max: 4 });
    a = await tenant("Company A");
    b = await tenant("Company B");
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("accepts a request whose case and requester belong to the same company", async () => {
    await insertRequest(a, 1);
    await insertRequest(b, 1); // request numbers are per company
    const rows = await sql`SELECT company_id, request_number FROM dr_requests ORDER BY company_id`;
    expect(rows).toHaveLength(2);
  });

  it("rejects a request that points its case at another company", async () => {
    // B's case with A's company id
    const t = { caseId: b.caseId, companyId: a.companyId, requesterId: a.requesterId };
    await expect(insertRequest(t, 2)).rejects.toThrow(/dr_requests_case_company_fk|duplicate key|violates/);
  });

  it("rejects another company's requester on a case", async () => {
    const [c2] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
      SELECT company_id, pipeline_id, stage_id, ${randomUUID()}, 'second' FROM pipeline_cases WHERE id = ${a.caseId} RETURNING id`;
    const t = { caseId: c2.id, companyId: a.companyId, requesterId: b.requesterId };
    await expect(insertRequest(t, 3)).rejects.toThrow(/dr_requests_requester_company_fk/);
  });

  it("rejects a duplicate_of case from another company and a self-duplicate", async () => {
    const [c3] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
      SELECT company_id, pipeline_id, stage_id, ${randomUUID()}, 'third' FROM pipeline_cases WHERE id = ${a.caseId} RETURNING id`;
    const t = { caseId: c3.id, companyId: a.companyId, requesterId: a.requesterId };
    await expect(insertRequest(t, 4, { duplicateOf: b.caseId })).rejects.toThrow(/dr_requests_duplicate_company_fk/);
    await expect(insertRequest(t, 4, { duplicateOf: c3.id })).rejects.toThrow(/dr_requests_duplicate_not_self_check/);
    await insertRequest(t, 4, { duplicateOf: a.caseId }); // same company is fine
  });

  it("enforces unique request numbers within a company and valid enum values", async () => {
    const [c4] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
      SELECT company_id, pipeline_id, stage_id, ${randomUUID()}, 'fourth' FROM pipeline_cases WHERE id = ${a.caseId} RETURNING id`;
    const t = { caseId: c4.id, companyId: a.companyId, requesterId: a.requesterId };
    await expect(insertRequest(t, 1)).rejects.toThrow(/dr_requests_company_number_uq/);
    await expect(insertRequest(t, 5, { priority: "critical" })).rejects.toThrow(/dr_requests_priority_check/);
    await insertRequest(t, 5, { priority: "urgent" });
  });

  it("rejects an attachment on another company's case and accepts the same company's", async () => {
    await expect(
      sql`INSERT INTO dr_attachments (company_id, case_id, asset_id) VALUES (${a.companyId}, ${b.caseId}, ${a.assetId})`,
    ).rejects.toThrow(/dr_attachments_case_company_fk/);
    await expect(
      sql`INSERT INTO dr_attachments (company_id, case_id, asset_id, uploaded_by_requester_id)
          VALUES (${a.companyId}, ${a.caseId}, ${a.assetId}, ${b.requesterId})`,
    ).rejects.toThrow(/dr_attachments_requester_company_fk/);
    await sql`INSERT INTO dr_attachments (company_id, case_id, asset_id, uploaded_by_requester_id)
              VALUES (${a.companyId}, ${a.caseId}, ${a.assetId}, ${a.requesterId})`;
  });

  it("allocates distinct REQ numbers under concurrency with one upsert", async () => {
    const [c] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Counter Co', ${prefix()}) RETURNING id`;
    const next = () =>
      sql`INSERT INTO dr_request_counters (company_id, last_number) VALUES (${c.id}, 1)
          ON CONFLICT (company_id) DO UPDATE SET last_number = dr_request_counters.last_number + 1, updated_at = now()
          RETURNING last_number`;
    const numbers = (await Promise.all(Array.from({ length: 25 }, next))).map((r) => r[0].last_number as number);
    expect(new Set(numbers).size).toBe(25);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(25);
  });

  it("deletes the request row and its attachments when the case is deleted", async () => {
    const c = await tenant("Company C");
    await insertRequest(c, 1);
    await sql`INSERT INTO dr_attachments (company_id, case_id, asset_id, uploaded_by_requester_id)
              VALUES (${c.companyId}, ${c.caseId}, ${c.assetId}, ${c.requesterId})`;
    await sql`DELETE FROM pipeline_cases WHERE id = ${c.caseId}`;
    expect(await sql`SELECT 1 FROM dr_requests WHERE case_id = ${c.caseId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM dr_attachments WHERE case_id = ${c.caseId}`).toHaveLength(0);
  });

  it("refuses to delete a case that another request names as its original", async () => {
    // c3 above was marked as a duplicate of a.caseId in the same company
    await expect(sql`DELETE FROM pipeline_cases WHERE id = ${a.caseId}`).rejects.toThrow(/dr_requests_duplicate_company_fk/);
  });
});
