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
