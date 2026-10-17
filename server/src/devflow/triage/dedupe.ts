import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Duplicate candidates for a new request (step 7). Lexical (pg_trgm) is always on; vector (pgvector) is
// added when the table exists, an embedding model is configured and the case has a vector. The model only
// ranks and explains what this module returns; it cannot name a case that was not offered.
// ponytail: sequential scan per company; add a trigram GIN index or HNSW once a company has many thousands of requests.

export interface DedupeConfig {
  minTrigram: number;
  minVector: number;
  limit: number;
}

export function loadDedupeConfig(env: NodeJS.ProcessEnv): DedupeConfig {
  return {
    minTrigram: Number(env.DEVFLOW_DEDUPE_MIN_TRIGRAM) || 0.3,
    minVector: Number(env.DEVFLOW_DEDUPE_MIN_VECTOR) || 0.65, // starting point, tune with real duplicate pairs
    limit: Number(env.DEVFLOW_DEDUPE_LIMIT) || 5,
  };
}

export interface Candidate {
  caseId: string;
  caseKey: string;
  title: string;
  stageKey: string;
  snippet: string;
  trigram: number | null;
  vector: number | null;
  score: number;
}

// Vietnamese diacritics folded in SQL and in the query text alike, so "cơ sở dữ liệu" matches "co so du lieu".
const ACCENTED = "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ";
const FOLD_FROM = ACCENTED;
const FOLD_TO = [...ACCENTED].map((c) => (c === "đ" ? "d" : c.normalize("NFD")[0])).join("");

export const foldText = (text: string): string =>
  [...text.normalize("NFC").toLowerCase()].map((c) => { const i = FOLD_FROM.indexOf(c); return i < 0 ? c : FOLD_TO[i]; }).join("");

export const contentHash = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

type Row = { case_id: string; case_key: string; title: string; stage_key: string; snippet: string; sim: number | string };
const toCandidate = (r: Row) => ({ caseId: r.case_id, caseKey: r.case_key, title: r.title, stageKey: r.stage_key, snippet: r.snippet });

/** Pure: union of both lists, filtered by their own thresholds, ranked by the stronger score. */
export function mergeCandidates(trigramRows: Row[], vectorRows: Row[], cfg: DedupeConfig): Candidate[] {
  const byCase = new Map<string, Candidate>();
  const put = (r: Row, kind: "trigram" | "vector") => {
    const sim = Number(r.sim);
    const cur = byCase.get(r.case_id) ?? { ...toCandidate(r), trigram: null, vector: null, score: 0 };
    cur[kind] = sim;
    cur.score = Math.max(cur.trigram ?? 0, cur.vector ?? 0);
    byCase.set(r.case_id, cur);
  };
  for (const r of trigramRows) if (Number(r.sim) >= cfg.minTrigram) put(r, "trigram");
  for (const r of vectorRows) if (Number(r.sim) >= cfg.minVector) put(r, "vector");
  return [...byCase.values()].sort((a, b) => b.score - a.score).slice(0, cfg.limit);
}

export function dedupeService(db: Db, cfg: DedupeConfig) {
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

  const hasTrigram = async () => (await rows<{ ok: boolean }>(sql`select exists (select 1 from pg_extension where extname = 'pg_trgm') as ok`))[0]?.ok === true;
  const hasVectorTable = async () => (await rows<{ ok: boolean }>(sql`select to_regclass('dr_embeddings') is not null as ok`))[0]?.ok === true;

  const folded = (col: ReturnType<typeof sql>) => sql`translate(lower(${col}), ${FOLD_FROM}, ${FOLD_TO})`;
  const scope = (companyId: string, caseId: string) => sql`
    c.company_id = ${companyId} and c.id <> ${caseId} and p.key = 'dev-request'
    and c.terminal_kind is distinct from 'cancelled'`;

  async function trigramRows(companyId: string, caseId: string, title: string, description: string) {
    if (!(await hasTrigram())) return [];
    const qTitle = foldText(title);
    const qDoc = foldText(`${title} ${description}`).slice(0, 1000);
    return rows<Row>(sql`
      select * from (
        select c.id as case_id, c.case_key, c.title, st.key as stage_key, left(r.description, 300) as snippet,
          greatest(
            similarity(${folded(sql`c.title`)}, ${qTitle}),
            similarity(left(${folded(sql`c.title || ' ' || r.description`)}, 1000), ${qDoc})
          ) as sim
        from pipeline_cases c
        join pipelines p on p.id = c.pipeline_id
        join pipeline_stages st on st.id = c.stage_id
        join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
        where ${scope(companyId, caseId)}
      ) t where sim >= ${cfg.minTrigram} order by sim desc limit 10`);
  }

  async function vectorRows(companyId: string, caseId: string, model: string, vector: number[]) {
    if (!(await hasVectorTable())) return [];
    const lit = `[${vector.join(",")}]`;
    return rows<Row>(sql`
      select c.id as case_id, c.case_key, c.title, st.key as stage_key, left(r.description, 300) as snippet,
        1 - (e.embedding <=> ${lit}::vector) as sim
      from dr_embeddings e
      join pipeline_cases c on c.id = e.case_id and c.company_id = e.company_id
      join pipelines p on p.id = c.pipeline_id
      join pipeline_stages st on st.id = c.stage_id
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      where e.company_id = ${companyId} and e.kind = 'request' and e.model = ${model} and e.dimensions = ${vector.length}
        and ${scope(companyId, caseId)}
      order by e.embedding <=> ${lit}::vector limit 10`);
  }

  return {
    hasVectorTable,
    /** Best effort: any failure means "no candidates", never a failed triage. */
    async findCandidates(input: { companyId: string; caseId: string; title: string; description: string; model?: string; vector?: number[] | null }) {
      const [t, v] = await Promise.all([
        trigramRows(input.companyId, input.caseId, input.title, input.description),
        input.model && input.vector ? vectorRows(input.companyId, input.caseId, input.model, input.vector) : Promise.resolve([] as Row[]),
      ]);
      return { candidates: mergeCandidates(t, v, cfg), mode: input.model && input.vector ? "trigram+vector" : "trigram" };
    },
    /** Returns false when the table is missing (no pgvector) so callers can stop trying. */
    async saveEmbedding(companyId: string, caseId: string, model: string, vector: number[], hash: string) {
      if (!(await hasVectorTable())) return false;
      const lit = `[${vector.join(",")}]`;
      await db.execute(sql`
        insert into dr_embeddings (company_id, case_id, kind, model, dimensions, embedding, content_hash)
        values (${companyId}, ${caseId}, 'request', ${model}, ${vector.length}, ${lit}::vector, ${hash})
        on conflict (case_id, kind, model) do update
          set embedding = excluded.embedding, dimensions = excluded.dimensions, content_hash = excluded.content_hash, created_at = now()
          where dr_embeddings.content_hash <> excluded.content_hash`);
      return true;
    },
    /** Requests without a vector for this model, oldest first. */
    async missingEmbeddings(model: string, limit: number) {
      if (!(await hasVectorTable())) return [];
      return rows<{ case_id: string; company_id: string; title: string; description: string; business_impact: string | null }>(sql`
        select c.id as case_id, c.company_id, c.title, r.description, r.business_impact
        from pipeline_cases c
        join pipelines p on p.id = c.pipeline_id
        join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
        where p.key = 'dev-request' and p.archived_at is null and c.terminal_kind is distinct from 'cancelled'
          and not exists (select 1 from dr_embeddings e where e.case_id = c.id and e.kind = 'request' and e.model = ${model})
        order by c.created_at limit ${limit}`);
    },
  };
}
