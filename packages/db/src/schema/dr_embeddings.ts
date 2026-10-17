import { sql } from "drizzle-orm";
import { check, customType, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";

// Embeddings for duplicate detection (openspec/decisions/0013).
//
// This table only exists where pgvector is available: the migration creates it inside a DO block that
// checks pg_available_extensions, because the embedded Postgres used by tests and by `pnpm dev` ships
// without pgvector. Code that reads it must check `to_regclass('dr_embeddings')` first.

/**
 * pgvector `vector` without a fixed dimension, so API and local models can coexist (one row per model).
 * An index needs a fixed dimension: create one per model with an expression index
 * `((embedding::vector(N)))` and a `where model = '...'` predicate once a model is chosen.
 */
export const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => value.slice(1, -1).split(",").map(Number),
});

export const drEmbeddings = pgTable(
  "dr_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    kind: text("kind").notNull().default("request"),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    embedding: pgVector("embedding").notNull(),
    // hash of the embedded text, to tell a stale embedding from a current one
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseFk: foreignKey({
      name: "dr_embeddings_case_company_fk",
      columns: [table.caseId, table.companyId],
      foreignColumns: [pipelineCases.id, pipelineCases.companyId],
    }).onDelete("cascade"),
    caseKindModelUq: uniqueIndex("dr_embeddings_case_kind_model_uq").on(table.caseId, table.kind, table.model),
    companyModelIdx: index("dr_embeddings_company_model_idx").on(table.companyId, table.model),
    kindCheck: check("dr_embeddings_kind_check", sql`${table.kind} in ('request')`),
    dimensionsCheck: check(
      "dr_embeddings_dimensions_check",
      sql`${table.dimensions} between 1 and 16000 and vector_dims(${table.embedding}) = ${table.dimensions}`,
    ),
    namesCheck: check("dr_embeddings_names_check", sql`${table.model} <> '' and ${table.contentHash} <> ''`),
  }),
);
