/**
 * DevFlow member roles (migration 0360, change add-approver-roles): several business roles per person per
 * company, a closed role list enforced by the database, and cleanup with the company.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0360_devflow_member_roles.sql", import.meta.url), "utf8");

describe("migration 0360 file", () => {
  it("only creates the member roles table", () => {
    const tables = [...migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(tables).toEqual(["dr_member_roles"]);
    expect(migrationSql).not.toMatch(/DROP |ALTER TABLE "(?!dr_member_roles)/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_member_roles", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;

  const prefix = () => randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");
  async function company(label: string): Promise<string> {
    const [row] = await sql`INSERT INTO companies (name, issue_prefix) VALUES (${label}, ${prefix()}) RETURNING id`;
    return row.id as string;
  }
  const grant = (companyId: string, userId: string, role: string) =>
    sql`INSERT INTO dr_member_roles (company_id, user_id, role) VALUES (${companyId}, ${userId}, ${role})`;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("devflow-member-roles-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 4 });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("lets one person hold both roles but not the same role twice", async () => {
    const c = await company("Roles A");
    await grant(c, "user-1", "ba");
    await grant(c, "user-1", "tech_lead");
    await expect(grant(c, "user-1", "ba")).rejects.toThrow(/dr_member_roles_company_user_role_uq/);
    const rows = await sql`SELECT role FROM dr_member_roles WHERE company_id = ${c} AND user_id = 'user-1' ORDER BY role`;
    expect(rows.map((r) => r.role)).toEqual(["ba", "tech_lead"]);
  });

  it("keeps roles inside their company", async () => {
    const a = await company("Roles B1");
    const b = await company("Roles B2");
    await grant(a, "user-2", "tech_lead");
    await grant(b, "user-2", "ba");
    const inA = await sql`SELECT role FROM dr_member_roles WHERE company_id = ${a} AND user_id = 'user-2'`;
    expect(inA.map((r) => r.role)).toEqual(["tech_lead"]);
  });

  it("accepts only the closed role list", async () => {
    const c = await company("Roles C");
    for (const role of ["", "admin", "BA", "tech-lead", "ba,tech_lead"]) {
      await expect(grant(c, "user-3", role)).rejects.toThrow(/dr_member_roles_role_check/);
    }
  });

  it("rejects a company that does not exist and removes roles with the company", async () => {
    await expect(grant(randomUUID(), "user-4", "ba")).rejects.toThrow(/dr_member_roles_company_id_companies_id_fk/);
    const c = await company("Roles D");
    await grant(c, "user-4", "ba");
    await sql`DELETE FROM companies WHERE id = ${c}`;
    expect(await sql`SELECT 1 FROM dr_member_roles WHERE company_id = ${c}`).toHaveLength(0);
  });
});

/**
 * Migration 0362 (change add-qa-stage): the closed role list gains `qa`, and nothing else about the table moves.
 */
const qaMigrationSql = fs.readFileSync(new URL("./migrations/0362_devflow_qa_role.sql", import.meta.url), "utf8");

describe("migration 0362 file", () => {
  it("only replaces the role check on dr_member_roles", () => {
    expect(qaMigrationSql).toMatch(/DROP CONSTRAINT "dr_member_roles_role_check"/);
    expect(qaMigrationSql).toMatch(/'ba', 'tech_lead', 'qa'/);
    expect(qaMigrationSql).not.toMatch(/CREATE TABLE|DROP TABLE|DROP COLUMN|DELETE |UPDATE /);
    expect([...qaMigrationSql.matchAll(/ALTER TABLE "([a-z_]+)"/g)].every((m) => m[1] === "dr_member_roles")).toBe(true);
  });
});

describeEmbeddedPostgres("dr_member_roles with the qa role", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;
  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("devflow-member-roles-qa-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 2 });
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });
  const prefix = () => randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");

  it("accepts qa next to the other roles and still refuses anything else", async () => {
    const [c] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Roles QA', ${prefix()}) RETURNING id`;
    for (const role of ["ba", "tech_lead", "qa"]) await sql`INSERT INTO dr_member_roles (company_id, user_id, role) VALUES (${c.id}, 'user-q', ${role})`;
    const rows = await sql`SELECT role FROM dr_member_roles WHERE company_id = ${c.id} ORDER BY role`;
    expect(rows.map((r) => r.role)).toEqual(["ba", "qa", "tech_lead"]);
    for (const role of ["QA", "qa ", "tester", "qa,ba", ""]) {
      await expect(sql`INSERT INTO dr_member_roles (company_id, user_id, role) VALUES (${c.id}, 'user-q2', ${role})`).rejects.toThrow(/dr_member_roles_role_check/);
    }
  });
});
