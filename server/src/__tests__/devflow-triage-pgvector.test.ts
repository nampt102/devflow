import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  applyPendingMigrations,
  authUsers,
  companies,
  costEvents,
  createDb,
  drAgentOutputs,
  drRequesters,
  drRequests,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { pipelineService } from "../services/pipelines.js";
import { dedupeService, loadDedupeConfig } from "../devflow/triage/dedupe.js";
import { fakeEmbedding, startFakeLlm, type FakeLlm } from "../devflow/triage/fake-llm.js";
import { loadEmbedConfig } from "../devflow/triage/embed-client.js";
import { triageService } from "../devflow/triage/triage-service.js";

// Vector path of step 7 on a real pgvector server. Skipped unless DEVFLOW_PGVECTOR_URL points at one
// (admin connection); it creates a throwaway database, applies every migration, and drops it afterwards.
//   DEVFLOW_PGVECTOR_URL=postgres://paperclip:paperclip@docker-db-1:5432/postgres
const adminUrl = process.env.DEVFLOW_PGVECTOR_URL;
const describeWithPgvector = adminUrl ? describe : describe.skip;

describeWithPgvector("devflow triage dedupe (pgvector)", () => {
  const dbName = `devflow_dedupe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin!: ReturnType<typeof createDb>;
  let db!: ReturnType<typeof createDb>;
  let fake!: FakeLlm;
  const embedModel = "fake-embed";

  beforeAll(async () => {
    admin = createDb(adminUrl!);
    await admin.execute(sql.raw(`CREATE DATABASE ${dbName}`));
    const target = new URL(adminUrl!);
    target.pathname = `/${dbName}`;
    await applyPendingMigrations(target.toString());
    db = createDb(target.toString());
    fake = await startFakeLlm();
  }, 300_000);

  afterAll(async () => {
    await fake?.close();
    await admin?.execute(sql.raw(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
  });

  const service = () =>
    triageService(db, {
      pipelines: pipelineService(db),
      cost: costService(db),
      llm: { baseUrl: fake.baseUrl, model: "fake-model", timeoutMs: 400, maxOutputTokens: 500, responseFormat: "json_object" },
      embed: loadEmbedConfig({ DEVFLOW_EMBED_BASE_URL: fake.baseUrl, DEVFLOW_EMBED_MODEL: embedModel, DEVFLOW_EMBED_TIMEOUT_MS: "400" }),
    });
  const dedupe = dedupeService(createDbLazy(), loadDedupeConfig({}));
  function createDbLazy() {
    // dedupe needs the per-test db; resolved on first use through a proxy
    return new Proxy({} as typeof db, { get: (_t, k) => (db as any)[k] });
  }

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Vec Co", issuePrefix: `V${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      { pipelineId: pipeline.id, key: "triage_review", name: "Triage Review", kind: "review", position: 150, config: { approveToStageKey: "triage", rejectToStageKey: "triage" } },
    ]);
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company.id, userId }).returning();
    return { company, pipeline, userId, requester };
  }

  let counter = 0;
  async function seedRequest(ctx: Awaited<ReturnType<typeof seedCompany>>, title: string, description: string) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title,
      stageKey: "triage",
      actor: { type: "user", userId: ctx.userId },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description, businessImpact: null });
    return { id: created.id as string, key: `REQ-${n}` };
  }

  const embeddingRows = (caseId: string) => db.execute(sql`select model, dimensions, content_hash from dr_embeddings where case_id = ${caseId}`) as unknown as Promise<Array<{ model: string; dimensions: number; content_hash: string }>>;
  const vec = (values: number[]) => values;

  it("triage stores the request vector and records embedding usage on the triage agent", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, "Báo cáo tồn kho", "Xem tồn kho theo kho.");
    fake.embedRequests.length = 0;
    expect(await service().triageCase(ctx.company.id, r.id)).toBe("proposed");
    expect(fake.embedRequests).toHaveLength(1);
    const rows = await embeddingRows(r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: embedModel, dimensions: 32 });
    const costs = await db.select().from(costEvents).where(and(eq(costEvents.companyId, ctx.company.id), eq(costEvents.billingCode, "devflow:embed")));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ costStatus: "unpriced", inputTokens: 7, model: embedModel });
  });

  it("offers a candidate found by vector similarity with its score, and keeps both scores in the output", async () => {
    const ctx = await seedCompany();
    const earlier = await seedRequest(ctx, "Xuất báo cáo tồn kho", "Xuất báo cáo tồn kho theo kho mỗi sáng.");
    await service().embedPending(50); // backfill the earlier request (and others without vectors)
    expect(await embeddingRows(earlier.id)).toHaveLength(1);
    const fresh = await seedRequest(ctx, "Báo cáo tồn kho theo kho", "Xuất báo cáo tồn kho theo kho mỗi sáng.");
    fake.requests.length = 0;
    await service().triageCase(ctx.company.id, fresh.id);
    const user = fake.requests.at(-1)!.body.messages[1].content as string;
    expect(user).toContain(`[${earlier.key}]`);
    const [out] = await db.select().from(drAgentOutputs).where(eq(drAgentOutputs.caseId, fresh.id));
    const data = out.data as any;
    expect(data.dedupeMode).toBe("trigram+vector");
    expect(data.candidateScores[0]).toMatchObject({ caseKey: earlier.key });
    expect(data.candidateScores[0].vector).toBeGreaterThan(0.65);
  });

  it("ranks by cosine, applies the vector threshold, and isolates by model, dimension, company and cancelled", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const near = await seedRequest(a, "alpha", "alpha");
    const far = await seedRequest(a, "beta", "beta");
    const cancelled = await seedRequest(a, "gamma", "gamma");
    const otherModel = await seedRequest(a, "delta", "delta");
    const otherDims = await seedRequest(a, "epsilon", "epsilon");
    const theirs = await seedRequest(b, "zeta", "zeta");
    const self = await seedRequest(a, "eta", "eta");
    await db.update(pipelineCases).set({ terminalKind: "cancelled" }).where(eq(pipelineCases.id, cancelled.id));
    const put = (companyId: string, caseId: string, model: string, v: number[]) =>
      dedupe.saveEmbedding(companyId, caseId, model, v, `sha256:${caseId}${model}`);
    const q = vec([1, 0, 0, 0]);
    await put(a.company.id, near.id, embedModel, vec([0.95, 0.1, 0, 0]));
    await put(a.company.id, far.id, embedModel, vec([0.2, 1, 0, 0]));
    await put(a.company.id, cancelled.id, embedModel, vec([1, 0, 0, 0]));
    await put(a.company.id, otherModel.id, "other-model", vec([1, 0, 0, 0]));
    await put(a.company.id, otherDims.id, embedModel, vec([1, 0, 0]));
    await put(b.company.id, theirs.id, embedModel, vec([1, 0, 0, 0]));
    await put(a.company.id, self.id, embedModel, vec([1, 0, 0, 0]));
    const { candidates } = await dedupe.findCandidates({ companyId: a.company.id, caseId: self.id, title: "qqq", description: "qqq", model: embedModel, vector: q });
    expect(candidates.map((c) => c.caseKey)).toEqual([near.key]);
    expect(candidates[0].vector).toBeGreaterThan(0.9);
  });

  it("an embedding failure does not fail triage: it is logged and the case is still proposed", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, "Thêm cột ghi chú", "Thêm cột ghi chú vào bảng.");
    fake.embedQueue.push({ status: 500 });
    expect(await service().triageCase(ctx.company.id, r.id)).toBe("proposed");
    expect(await embeddingRows(r.id)).toHaveLength(0);
    const logs = await db.select().from(activityLog).where(and(eq(activityLog.entityId, r.id), eq(activityLog.action, "agent.embed_failed")));
    expect(logs).toHaveLength(1);
    expect((logs[0].details as any).kind).toBe("server_error");
    // the backfill picks it up later
    expect((await service().embedPending(50)).embedded).toBeGreaterThanOrEqual(1);
    expect(await embeddingRows(r.id)).toHaveLength(1);
  });

  it("keeps the stored vector when the text is unchanged and replaces it when the text changes", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, "Báo cáo kho", "Nội dung.");
    await dedupe.saveEmbedding(ctx.company.id, r.id, embedModel, vec([1, 0]), "sha256:one");
    await dedupe.saveEmbedding(ctx.company.id, r.id, embedModel, vec([0, 1]), "sha256:one");
    const same = await db.execute(sql`select embedding::text as e from dr_embeddings where case_id = ${r.id}`) as unknown as Array<{ e: string }>;
    expect(same[0].e).toBe("[1,0]");
    await dedupe.saveEmbedding(ctx.company.id, r.id, embedModel, vec([0, 1]), "sha256:two");
    const changed = await db.execute(sql`select embedding::text as e from dr_embeddings where case_id = ${r.id}`) as unknown as Array<{ e: string }>;
    expect(changed[0].e).toBe("[0,1]");
  });

  it("fake embeddings of similar texts are close (sanity for the tests above)", () => {
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(fakeEmbedding("báo cáo tồn kho theo kho"), fakeEmbedding("tồn kho theo kho báo cáo"))).toBeGreaterThan(0.99);
  });
});
