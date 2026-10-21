/**
 * Agent Dev columns on dr_systems (migration 0361, change add-dev-stage): defaults keep Dev off, and the checks
 * stop a system being switched on without a write token or carrying unbounded commands and path lists.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0361_devflow_dev_stage.sql", import.meta.url), "utf8");

describe("migration 0361 file", () => {
  it("only adds columns and checks to dr_systems", () => {
    expect([...migrationSql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].every((m) => m[1] === "dr_systems")).toBe(true);
    expect(migrationSql).not.toMatch(/DROP |CREATE TABLE/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_systems Dev columns", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;
  let companyId: string;
  let n = 0;

  const insert = (cols: string, values: unknown[]) => {
    n += 1;
    return sql.unsafe(
      `INSERT INTO dr_systems (company_id, key, name, repo_url${cols}) VALUES ($1, $2, 'S', 'https://github.com/acme/r'${values.map((_, i) => `, $${i + 3}`).join("")}) RETURNING *`,
      [companyId, `s-${n}`, ...(values as never[])],
    );
  };

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("devflow-systems-dev-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 2 });
    const prefix = randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");
    [{ id: companyId }] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Dev cols', ${prefix}) RETURNING id`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("keeps Dev off with safe defaults for existing and new systems", async () => {
    const [s] = await insert("", []);
    expect(s).toMatchObject({
      dev_enabled: false, write_token_secret_id: null, test_command: null, forbidden_paths: [], allow_unprotected: false,
    });
  });

  it("refuses to enable Dev without a write token", async () => {
    await expect(insert(", dev_enabled", [true])).rejects.toThrow(/dr_systems_dev_token_check/);
    const [ok] = await insert(", dev_enabled, write_token_secret_id", [true, randomUUID()]);
    expect(ok.dev_enabled).toBe(true);
  });

  it("bounds the test command and the forbidden path list", async () => {
    await expect(insert(", test_command", [""])).rejects.toThrow(/dr_systems_test_command_check/);
    await expect(insert(", test_command", ["x".repeat(501)])).rejects.toThrow(/dr_systems_test_command_check/);
    const [ok] = await insert(", test_command", ["x".repeat(500)]);
    expect(ok.test_command).toHaveLength(500);
    const many = Array.from({ length: 51 }, (_, i) => `p${i}`);
    await expect(insert(", forbidden_paths", [many])).rejects.toThrow(/dr_systems_forbidden_paths_check/);
    const [fine] = await insert(", forbidden_paths", [many.slice(0, 50)]);
    expect(fine.forbidden_paths).toHaveLength(50);
  });
});
