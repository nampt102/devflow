/**
 * DevFlow agent output tables (migration 0357, openspec/decisions/0013): structured proposals, the human
 * changes to them, and the optional embeddings table. Runs on the embedded Postgres, which has no pgvector,
 * so it also proves the migration applies cleanly without it.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0357_devflow_agent_outputs.sql", import.meta.url), "utf8");

describe("migration 0357 file", () => {
  it("creates the unique index before the composite foreign key that needs it", () => {
    const at = (needle: string) => {
      const i = migrationSql.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('CREATE UNIQUE INDEX "dr_agent_outputs_id_company_uq"')).toBeLessThan(at('ADD CONSTRAINT "dr_overrides_output_company_fk"'));
  });

  it("creates dr_embeddings only inside a block that checks for pgvector", () => {
    const create = migrationSql.indexOf('CREATE TABLE "dr_embeddings"');
    const guard = migrationSql.indexOf("pg_available_extensions WHERE name = 'vector'");
    const end = migrationSql.indexOf("END IF;", guard);
    expect(guard).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(guard);
    expect(create).toBeLessThan(end);
    // nothing outside the block (comments aside) may touch the table or the vector type
    const outside = migrationSql
      .slice(0, guard)
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(outside.includes("dr_embeddings")).toBe(false);
    expect(/\bvector\b/.test(outside)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dr_agent_outputs and dr_overrides", () => {
  let cleanup: () => Promise<void>;
  let sql: postgres.Sql;
  let vectorAvailable = false;

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

  const output = (t: Tenant, over: Record<string, unknown> = {}) => {
    const v = {
      stage: "triage", role: "triage", version: "v1", hash: "sha256:abc", data: { priority: "high" }, comment: "Đề xuất",
      status: "proposed", decidedAt: null as Date | null, decidedBy: null as string | null, ...over,
    };
    return sql`INSERT INTO dr_agent_outputs (company_id, case_id, stage_key, prompt_role, prompt_version, prompt_hash, data, comment_text, status, decided_at, decided_by_user_id)
               VALUES (${t.companyId}, ${t.caseId}, ${v.stage as string}, ${v.role as string}, ${v.version as string}, ${v.hash as string},
                       ${sql.json(v.data as postgres.JSONValue)}, ${v.comment as string}, ${v.status as string}, ${v.decidedAt}, ${v.decidedBy})
               RETURNING id`;
  };
  const override = (t: Tenant, outputId: string, over: Record<string, unknown> = {}) => {
    const v = { field: "priority", agent: "high", final: "low", ...over };
    return sql`INSERT INTO dr_overrides (company_id, case_id, output_id, stage_key, field, agent_value, final_value, actor_user_id)
               VALUES (${t.companyId}, ${t.caseId}, ${outputId}, 'triage', ${v.field as string},
                       ${v.agent === null ? null : sql.json(v.agent as postgres.JSONValue)}, ${v.final === null ? null : sql.json(v.final as postgres.JSONValue)}, 'reviewer')`;
  };

  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("devflow-dr-outputs-");
    cleanup = database.cleanup;
    sql = postgres(database.connectionString, { max: 4 });
    [{ available: vectorAvailable }] = await sql`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available`;
    a = await tenant("Outputs A");
    b = await tenant("Outputs B");
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await cleanup?.();
  });

  it("creates outputs and overrides everywhere, and embeddings only where pgvector exists", async () => {
    const [{ outputs, overrides, embeddings }] = await sql`
      SELECT to_regclass('dr_agent_outputs') IS NOT NULL AS outputs,
             to_regclass('dr_overrides') IS NOT NULL AS overrides,
             to_regclass('dr_embeddings') IS NOT NULL AS embeddings`;
    expect(outputs).toBe(true);
    expect(overrides).toBe(true);
    expect(embeddings).toBe(vectorAvailable); // false on the embedded Postgres, true where pgvector is installed
    expect(await sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`).toHaveLength(vectorAvailable ? 1 : 0);
  });

  it("keeps one live proposal per stage and lets a new one in after the old is superseded", async () => {
    const t = await tenant("One proposed");
    await output(t);
    await expect(output(t)).rejects.toThrow(/dr_agent_outputs_one_proposed_uq/);
    await output(t, { stage: "ba_spec" }); // another stage is independent
    await sql`UPDATE dr_agent_outputs SET status = 'superseded' WHERE case_id = ${t.caseId} AND stage_key = 'triage'`;
    await output(t); // a fresh proposal for the same stage is now fine
    expect(await sql`SELECT 1 FROM dr_agent_outputs WHERE case_id = ${t.caseId} AND stage_key = 'triage'`).toHaveLength(2);
  });

  it("enforces status, decision, size and naming rules", async () => {
    const t = await tenant("Rules");
    await expect(output(t, { status: "approved" })).rejects.toThrow(/dr_agent_outputs_status_check/);
    await expect(output(t, { status: "proposed", decidedAt: new Date() })).rejects.toThrow(/dr_agent_outputs_decision_check/);
    await expect(output(t, { status: "accepted" })).rejects.toThrow(/dr_agent_outputs_decision_check/);
    await expect(output(t, { status: "overridden", decidedAt: new Date() })).rejects.toThrow(/dr_agent_outputs_decision_check/);
    await output(t, { stage: "s1", status: "accepted", decidedAt: new Date(), decidedBy: "reviewer" });
    await expect(output(t, { data: [1, 2] })).rejects.toThrow(/dr_agent_outputs_data_check/);
    await expect(output(t, { data: { blob: "x".repeat(70_000) } })).rejects.toThrow(/dr_agent_outputs_data_check/);
    await expect(output(t, { comment: "x".repeat(20_001) })).rejects.toThrow(/dr_agent_outputs_comment_check/);
    for (const bad of [{ role: "" }, { version: "" }, { hash: "" }, { stage: "" }]) {
      await expect(output(t, bad), JSON.stringify(bad)).rejects.toThrow(/dr_agent_outputs_names_check/);
    }
  });

  it("rejects an output that points its case at another company, or names an unknown agent or run", async () => {
    await expect(output({ companyId: a.companyId, caseId: b.caseId })).rejects.toThrow(/dr_agent_outputs_case_company_fk/);
    const t = await tenant("Unknown refs");
    await expect(
      sql`INSERT INTO dr_agent_outputs (company_id, case_id, stage_key, agent_id, prompt_role, prompt_version, prompt_hash, data, comment_text)
          VALUES (${t.companyId}, ${t.caseId}, 'triage', ${randomUUID()}, 'triage', 'v1', 'h', '{}', 'c')`,
    ).rejects.toThrow(/dr_agent_outputs_agent_id_agents_id_fk/);
    await expect(
      sql`INSERT INTO dr_agent_outputs (company_id, case_id, stage_key, run_id, prompt_role, prompt_version, prompt_hash, data, comment_text)
          VALUES (${t.companyId}, ${t.caseId}, 'triage', ${randomUUID()}, 'triage', 'v1', 'h', '{}', 'c')`,
    ).rejects.toThrow(/dr_agent_outputs_run_id_heartbeat_runs_id_fk/);
  });

  it("records only real differences, once per field, and only against the same company's output", async () => {
    const t = await tenant("Overrides");
    const [out] = await output(t);
    await override(t, out.id);
    await expect(override(t, out.id, { final: "medium" })).rejects.toThrow(/dr_overrides_output_field_uq/);
    await expect(override(t, out.id, { field: "difficulty", agent: "easy", final: "easy" })).rejects.toThrow(/dr_overrides_changed_check/);
    await expect(override(t, out.id, { field: "difficulty", agent: null, final: null })).rejects.toThrow(/dr_overrides_changed_check/);
    await override(t, out.id, { field: "difficulty", agent: null, final: "hard" }); // the agent proposed nothing
    await override(t, out.id, { field: "requiresHuman", agent: false, final: null }); // the reviewer cleared it
    await expect(override(t, out.id, { field: "" })).rejects.toThrow(/dr_overrides_field_check/);
    await expect(override(t, out.id, { field: "f".repeat(201) })).rejects.toThrow(/dr_overrides_field_check/);

    const other = await tenant("Overrides other");
    await expect(override({ companyId: other.companyId, caseId: other.caseId }, out.id, { field: "x" })).rejects.toThrow(/dr_overrides_output_company_fk/);
  });

  it("deletes outputs and overrides with their case, and overrides with their output", async () => {
    const t = await tenant("Cascade");
    const [first] = await output(t);
    const [second] = await output(t, { stage: "ba_spec" });
    await override(t, first.id);
    await sql`DELETE FROM dr_agent_outputs WHERE id = ${first.id}`;
    expect(await sql`SELECT 1 FROM dr_overrides WHERE case_id = ${t.caseId}`).toHaveLength(0);
    await override(t, second.id, { field: "scope" });
    await sql`DELETE FROM pipeline_cases WHERE id = ${t.caseId}`;
    expect(await sql`SELECT 1 FROM dr_agent_outputs WHERE case_id = ${t.caseId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM dr_overrides WHERE case_id = ${t.caseId}`).toHaveLength(0);
  });

  it("supports the override-rate query per prompt version that the dashboard needs", async () => {
    const t = await tenant("Rate");
    const ids: string[] = [];
    for (const [stage, version] of [["s1", "v1"], ["s2", "v1"], ["s3", "v2"], ["s4", "v2"]] as const) {
      const [row] = await output(t, { stage, version, status: "accepted", decidedAt: new Date(), decidedBy: "reviewer" });
      ids.push(row.id);
    }
    await override(t, ids[0]); // v1: one of two outputs changed
    await override(t, ids[0], { field: "difficulty", agent: "easy", final: "hard" }); // still counts once
    const rows = await sql`
      SELECT o.prompt_version AS version, count(DISTINCT o.id)::int AS outputs, count(DISTINCT ov.output_id)::int AS changed
      FROM dr_agent_outputs o LEFT JOIN dr_overrides ov ON ov.output_id = o.id
      WHERE o.company_id = ${t.companyId} AND o.status IN ('accepted', 'overridden')
      GROUP BY o.prompt_version ORDER BY o.prompt_version`;
    expect(rows.map((r) => [r.version, r.outputs, r.changed])).toEqual([["v1", 2, 1], ["v2", 2, 0]]);
  });
});
