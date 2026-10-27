/**
 * Triage snooze (migration 0363, change add-triage-snooze): three nullable columns on dr_requests and a partial index; nothing
 * else moves, and requests that exist already stay un-snoozed.
 */

import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0363_devflow_triage_snooze.sql", import.meta.url), "utf8");

describe("migration 0363 file", () => {
  it("only adds the three columns and the index to dr_requests", () => {
    const cols = [...migrationSql.matchAll(/ADD COLUMN "([a-z_]+)"/g)].map((m) => m[1]);
    expect(cols).toEqual(["snoozed_until", "snoozed_by", "snooze_note"]);
    expect(migrationSql).not.toMatch(/DROP |CREATE TABLE|NOT NULL/);
    expect([...migrationSql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].every((m) => m[1] === "dr_requests")).toBe(true);
    expect(migrationSql).toMatch(/CREATE INDEX "dr_requests_snoozed_idx"[\s\S]*WHERE/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_requests snooze columns", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("devflow-requests-snooze-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 2 });
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("adds nullable columns of the expected types", async () => {
    const rows = await sql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'dr_requests' AND column_name IN ('snoozed_until', 'snoozed_by', 'snooze_note') ORDER BY column_name`;
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ["snooze_note", "text", "YES"],
      ["snoozed_by", "text", "YES"],
      ["snoozed_until", "timestamp with time zone", "YES"],
    ]);
  });

  it("indexes only the snoozed rows", async () => {
    const [row] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'dr_requests_snoozed_idx'`;
    expect(row.indexdef).toMatch(/\(company_id, snoozed_until\)/);
    expect(row.indexdef).toMatch(/WHERE \(?snoozed_until IS NOT NULL/);
  });
});
