/**
 * dr_embeddings on a real pgvector server (migration 0357, openspec/decisions/0013).
 *
 * The embedded Postgres has no pgvector, so this suite runs against an existing server that does. It is
 * skipped unless DEVFLOW_PGVECTOR_URL points at one (an admin connection, e.g. the docker compose db):
 *   DEVFLOW_PGVECTOR_URL=postgres://paperclip:paperclip@localhost:5432/postgres
 * It creates a throwaway database, applies every migration to it, and drops it afterwards.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb } from "./client.js";
import { drEmbeddings } from "./schema/dr_embeddings.js";

const adminUrl = process.env.DEVFLOW_PGVECTOR_URL;
const describeWithPgvector = adminUrl ? describe : describe.skip;

describeWithPgvector("dr_embeddings with pgvector", () => {
  const dbName = `devflow_pgvector_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let url: string;

  type Tenant = { companyId: string; caseId: string };
  const prefix = () => randomUUID().replace(/[^a-z]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");
  const vec = (values: number[]) => `[${values.join(",")}]`;

  async function tenant(label: string): Promise<Tenant> {
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES (${label}, ${prefix()}) RETURNING id`;
    const [pipeline] = await sql`INSERT INTO pipelines (company_id, key, name) VALUES (${company.id}, 'dev-request', 'Dev Request') RETURNING id`;
    const [stage] = await sql`INSERT INTO pipeline_stages (pipeline_id, key, name, kind, position)
                              VALUES (${pipeline.id}, 'triage', 'Triage', 'working', 100) RETURNING id`;
    const [kase] = await sql`INSERT INTO pipeline_cases (company_id, pipeline_id, stage_id, case_key, title)
                             VALUES (${company.id}, ${pipeline.id}, ${stage.id}, ${randomUUID()}, ${label}) RETURNING id`;
    return { companyId: company.id, caseId: kase.id };
  }

  const embed = (t: Tenant, values: number[], over: { model?: string; dimensions?: number; kind?: string } = {}) =>
    sql`INSERT INTO dr_embeddings (company_id, case_id, kind, model, dimensions, embedding, content_hash)
        VALUES (${t.companyId}, ${t.caseId}, ${over.kind ?? "request"}, ${over.model ?? "m4"}, ${over.dimensions ?? values.length},
                ${vec(values)}::vector, 'sha256:abc')`;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const target = new URL(adminUrl!);
    target.pathname = `/${dbName}`;
    url = target.toString();
    await applyPendingMigrations(url);
    sql = postgres(url, { max: 4 });
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("created the extension and the table, and the dimension check holds", async () => {
    expect(await sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`).toHaveLength(1);
    expect((await sql`SELECT to_regclass('dr_embeddings') IS NOT NULL AS ok`)[0].ok).toBe(true);
    const t = await tenant("Dimensions");
    await embed(t, [1, 0, 0, 0]);
    await expect(embed(t, [1, 0, 0, 0], { model: "m-bad", dimensions: 3 })).rejects.toThrow(/dr_embeddings_dimensions_check/);
    await expect(embed(t, [1, 0, 0, 0], { model: "m-zero", dimensions: 0 })).rejects.toThrow(/dr_embeddings_dimensions_check/);
    await expect(embed(t, [1, 0, 0, 0], { model: "" })).rejects.toThrow(/dr_embeddings_names_check/);
    await expect(embed(t, [1, 0, 0, 0], { model: "m-kind", kind: "spec" })).rejects.toThrow(/dr_embeddings_kind_check/);
  });

  it("keeps one embedding per case, kind and model, and allows several models side by side", async () => {
    const t = await tenant("Models");
    await embed(t, [1, 0, 0, 0], { model: "api-4" });
    await expect(embed(t, [0, 1, 0, 0], { model: "api-4" })).rejects.toThrow(/dr_embeddings_case_kind_model_uq/);
    await embed(t, [0, 1, 0], { model: "local-3" }); // a different model may have a different dimension
    expect(await sql`SELECT 1 FROM dr_embeddings WHERE case_id = ${t.caseId}`).toHaveLength(2);
  });

  it("finds the nearest requests per model even when other models use other dimensions", async () => {
    const [near, far, other] = [await tenant("Near"), await tenant("Far"), await tenant("Other dims")];
    await embed(near, [0.9, 0.1, 0, 0], { model: "nn-4" });
    await embed(far, [0, 0, 1, 0], { model: "nn-4" });
    await embed(other, [1, 0, 0], { model: "nn-3" }); // 3 dimensions in the same column
    const query = vec([1, 0, 0, 0]);
    const rows = await sql`
      SELECT case_id FROM dr_embeddings WHERE model = 'nn-4' AND company_id IN (${near.companyId}, ${far.companyId})
      ORDER BY embedding <=> ${query}::vector LIMIT 2`;
    expect(rows.map((r) => r.case_id)).toEqual([near.caseId, far.caseId]);

    // a per-model index with a fixed dimension, as planned for once a model is chosen
    await sql.unsafe(`CREATE INDEX dr_embeddings_nn4_idx ON dr_embeddings USING hnsw ((embedding::vector(4)) vector_cosine_ops) WHERE model = 'nn-4'`);
    const indexed = await sql`
      SELECT case_id FROM dr_embeddings WHERE model = 'nn-4' AND company_id IN (${near.companyId}, ${far.companyId})
      ORDER BY embedding::vector(4) <=> ${query}::vector(4) LIMIT 2`;
    expect(indexed.map((r) => r.case_id)).toEqual([near.caseId, far.caseId]);
  });

  it("refuses an embedding for another company's case and deletes embeddings with their case", async () => {
    const [a, b] = [await tenant("Iso A"), await tenant("Iso B")];
    await expect(embed({ companyId: a.companyId, caseId: b.caseId }, [1, 0, 0, 0])).rejects.toThrow(/dr_embeddings_case_company_fk/);
    await embed(a, [1, 0, 0, 0]);
    await sql`DELETE FROM pipeline_cases WHERE id = ${a.caseId}`;
    expect(await sql`SELECT 1 FROM dr_embeddings WHERE case_id = ${a.caseId}`).toHaveLength(0);
  });

  it("round-trips vectors through the drizzle column type", async () => {
    const t = await tenant("Drizzle");
    const db = createDb(url);
    await db.insert(drEmbeddings).values({
      companyId: t.companyId,
      caseId: t.caseId,
      model: "drizzle-4",
      dimensions: 4,
      embedding: [0.25, -0.5, 0.125, 1],
      contentHash: "sha256:abc",
    });
    const [row] = await sql`SELECT embedding::text AS text FROM dr_embeddings WHERE case_id = ${t.caseId}`;
    expect(row.text).toBe("[0.25,-0.5,0.125,1]");
    const [back] = await db.select().from(drEmbeddings).where(eq(drEmbeddings.caseId, t.caseId));
    expect(back.embedding).toEqual([0.25, -0.5, 0.125, 1]);
  });
});
