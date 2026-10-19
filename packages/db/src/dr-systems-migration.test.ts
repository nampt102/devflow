/**
 * DevFlow systems catalog (migration 0359, change add-ba-spec-stage): one row per repository a company's
 * requests can be about, company isolation by composite foreign keys, and the checks that keep the data safe
 * to hand to a git clone.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0359_devflow_systems.sql", import.meta.url), "utf8");

describe("migration 0359 file", () => {
  it("only creates the two systems tables and their constraints", () => {
    const tables = [...migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(["dr_request_systems", "dr_systems"]);
    expect(migrationSql).not.toMatch(/DROP |ALTER TABLE "(?!dr_request_systems|dr_systems)/);
  });

  it("creates the unique (id, company_id) index before the foreign key that needs it", () => {
    expect(migrationSql.indexOf('CREATE UNIQUE INDEX "dr_systems_id_company_uq"')).toBeGreaterThan(-1);
    expect(migrationSql.indexOf('CREATE UNIQUE INDEX "dr_systems_id_company_uq"')).toBeLessThan(
      migrationSql.indexOf('"dr_request_systems_system_company_fk"'),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_systems and dr_request_systems", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;

  type Tenant = { companyId: string; caseId: string };
  const prefix = () => randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");

  async function tenant(label: string): Promise<Tenant> {
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES (${label}, ${prefix()}) RETURNING id`;
    const [pipeline] = await sql`INSERT INTO pipelines (company_id, key, name) VALUES (${company.id}, 'dev-request', 'Dev Request') RETURNING id`;
    const [stage] = await sql`INSERT INTO pipeline_stages (pipeline_id, key, name, kind, position)
                              VALUES (${pipeline.id}, 'triage', 'Triage', 'working', 100) RETURNING id`;
    const [kase] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
                             VALUES (${company.id}, ${pipeline.id}, ${stage.id}, ${randomUUID()}, ${`case ${label}`}) RETURNING id`;
    return { companyId: company.id, caseId: kase.id };
  }

  const system = (companyId: string, over: Record<string, unknown> = {}) => {
    const v = {
      key: "hr-portal", name: "HR Portal", description: "", repoUrl: "https://github.com/acme/hr-portal", branch: "main", docs: "docs", ...over,
    };
    return sql`INSERT INTO dr_systems (company_id, key, name, description, repo_url, default_branch, docs_path)
               VALUES (${companyId}, ${v.key as string}, ${v.name as string}, ${v.description as string}, ${v.repoUrl as string},
                       ${v.branch as string}, ${v.docs as string}) RETURNING id`;
  };

  const assign = (t: Tenant, systemId: string) =>
    sql`INSERT INTO dr_request_systems (company_id, case_id, system_id) VALUES (${t.companyId}, ${t.caseId}, ${systemId})`;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("devflow-systems-");
    cleanup = db.cleanup;
    sql = postgres(db.connectionString, { max: 4 });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("stores a system with defaults and keeps keys unique per company only", async () => {
    const a = await tenant("Systems A");
    const b = await tenant("Systems B");
    const [s] = await system(a.companyId);
    const [saved] = await sql`SELECT active, token_secret_id, default_branch, docs_path FROM dr_systems WHERE id = ${s.id}`;
    expect(saved).toMatchObject({ active: true, token_secret_id: null, default_branch: "main", docs_path: "docs" });
    await expect(system(a.companyId)).rejects.toThrow(/dr_systems_company_key_uq/);
    await system(b.companyId);
  });

  it("accepts only slug keys", async () => {
    const t = await tenant("Systems C");
    for (const key of ["", "HR", "-hr", "hr portal", "hr_portal", "x".repeat(64)]) {
      await expect(system(t.companyId, { key })).rejects.toThrow(/dr_systems_key_check/);
    }
    await system(t.companyId, { key: "a" });
    await system(t.companyId, { key: "x".repeat(63) });
  });

  it("accepts only plain github.com repository URLs", async () => {
    const t = await tenant("Systems D");
    const bad = [
      "http://github.com/acme/hr", "https://gitlab.com/acme/hr", "https://github.com/acme", "https://github.com/acme/hr/tree/main",
      "https://user:token@github.com/acme/hr", "https://github.com.evil.test/acme/hr", "https://github.com/acme/hr --upload-pack=x",
      "git@github.com:acme/hr.git", "file:///etc/passwd",
    ];
    for (const [i, repoUrl] of bad.entries()) {
      await expect(system(t.companyId, { key: `bad-${i}`, repoUrl })).rejects.toThrow(/dr_systems_repo_check/);
    }
    await system(t.companyId, { key: "ok-1", repoUrl: "https://github.com/acme/hr-portal.v2" });
  });

  it("keeps the docs path inside the repository", async () => {
    const t = await tenant("Systems E");
    for (const docs of ["/etc", "../docs", "docs/../../x", ".."]) {
      await expect(system(t.companyId, { key: "docs-x", docs })).rejects.toThrow(/dr_systems_docs_check/);
    }
    await system(t.companyId, { key: "docs-ok", docs: "docs/business" });
  });

  it("bounds the stored text", async () => {
    const t = await tenant("Systems F");
    await expect(system(t.companyId, { key: "n0", name: "" })).rejects.toThrow(/dr_systems_size_check/);
    await expect(system(t.companyId, { key: "n1", name: "x".repeat(201) })).rejects.toThrow(/dr_systems_size_check/);
    await expect(system(t.companyId, { key: "n2", description: "x".repeat(2001) })).rejects.toThrow(/dr_systems_size_check/);
  });

  it("assigns a system to a case once and rejects a system or case of another company", async () => {
    const a = await tenant("Systems G1");
    const b = await tenant("Systems G2");
    const [sa] = await system(a.companyId);
    const [sb] = await system(b.companyId);
    await assign(a, sa.id);
    await expect(assign(a, sa.id)).rejects.toThrow(/dr_request_systems_pk/);
    await expect(assign(a, sb.id)).rejects.toThrow(/dr_request_systems_system_company_fk/);
    await expect(sql`INSERT INTO dr_request_systems (company_id, case_id, system_id) VALUES (${a.companyId}, ${b.caseId}, ${sa.id})`).rejects.toThrow(
      /dr_request_systems_case_company_fk/,
    );
  });

  it("removes assignments with their case or their system, and everything with the company", async () => {
    const t = await tenant("Systems H");
    const [s1] = await system(t.companyId, { key: "s1" });
    const [s2] = await system(t.companyId, { key: "s2" });
    await assign(t, s1.id);
    await assign(t, s2.id);
    await sql`DELETE FROM dr_systems WHERE id = ${s1.id}`;
    expect(await sql`SELECT system_id FROM dr_request_systems WHERE case_id = ${t.caseId}`).toHaveLength(1);
    await sql`DELETE FROM pipeline_cases WHERE id = ${t.caseId}`;
    expect(await sql`SELECT 1 FROM dr_request_systems WHERE company_id = ${t.companyId}`).toHaveLength(0);
    await sql`DELETE FROM companies WHERE id = ${t.companyId}`;
    expect(await sql`SELECT 1 FROM dr_systems WHERE company_id = ${t.companyId}`).toHaveLength(0);
  });
});
