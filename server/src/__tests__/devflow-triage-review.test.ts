import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  createDb,
  drAgentOutputs,
  drOverrides,
  drRequesters,
  drRequests,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { triageReviewRoutes } from "../devflow/triage-review/routes.js";
import { triageService } from "../devflow/triage/triage-service.js";
import { startFakeLlm, type FakeLlm } from "../devflow/triage/fake-llm.js";

// Staff review of Triage proposals (step 8): queue, detail, decisions, overrides, atomicity, access.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow triage review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let fake!: FakeLlm;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-review-");
    db = createDb(tempDb.connectionString);
    fake = await startFakeLlm();
  }, 60_000);

  afterAll(async () => {
    await fake?.close();
    await tempDb?.cleanup();
  });

  const svc = () => pipelineService(db);
  const staff = (userId: string, companyId: string, role = "member"): Express.Request["actor"] => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }] as any,
    isInstanceAdmin: false,
  });
  const app = (actor: Express.Request["actor"]) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", triageReviewRoutes(db, { reviewCase: (input) => svc().reviewCase(input) }));
    a.use(errorHandler);
    return a;
  };

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Review Co", issuePrefix: `R${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      {
        pipelineId: pipeline.id,
        key: "triage_review",
        name: "Triage Review",
        kind: "review",
        position: 150,
        config: { requireApproval: true, approver: { kind: "any_human" }, approveToStageKey: "ba_spec", rejectToStageKey: "cancelled", requestChangesToStageKey: "triage", requireRejectReason: true, requireRequestChangesReason: true },
      },
      { pipelineId: pipeline.id, key: "ba_spec", name: "BA Spec", kind: "working", position: 200 },
      { pipelineId: pipeline.id, key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
    ]);
    const requesterUser = `user-${randomUUID()}`;
    const reviewer = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([
      { id: requesterUser, name: "Nguyễn Văn A", email: `${requesterUser}@example.test`, createdAt: now, updatedAt: now },
      { id: reviewer, name: "Reviewer", email: `${reviewer}@example.test`, createdAt: now, updatedAt: now },
    ]);
    const [requester] = await db.insert(drRequesters).values({ companyId: company.id, userId: requesterUser }).returning();
    return { company, pipeline, requesterUser, requester, reviewer };
  }

  const proposal = (over: Record<string, unknown> = {}) => ({
    classification: "feature",
    classificationReason: "Cần thêm báo cáo.",
    priority: "medium",
    priorityReason: "Việc thường.",
    difficulty: "easy",
    difficultyReason: "Đơn giản.",
    requiresHuman: false,
    requiresHumanReasons: [],
    modelRequiresHumanReasons: [],
    ruleFlags: [],
    duplicateCandidates: [],
    candidateScores: [],
    dedupeMode: "trigram",
    summary: "Tóm tắt.",
    confidence: 0.8,
    assumptions: ["Giả định 1"],
    openQuestions: ["Câu hỏi 1"],
    model: "fake",
    ...over,
  });

  let counter = 0;
  /** A request waiting in triage_review with a proposed output (or left in triage when `stage` says so). */
  async function seedRequest(
    ctx: Awaited<ReturnType<typeof seedCompany>>,
    over: { data?: Record<string, unknown>; stage?: "triage" | "triage_review"; title?: string } = {},
  ) {
    const n = ++counter;
    const { case: created } = await svc().ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: over.title ?? `Yêu cầu ${n}`,
      stageKey: "triage",
      actor: { type: "user", userId: ctx.requesterUser },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "Mô tả chi tiết", businessImpact: "Ảnh hưởng 5 người" });
    const [output] = await db
      .insert(drAgentOutputs)
      .values({ companyId: ctx.company.id, caseId: created.id, stageKey: "triage", promptRole: "triage", promptVersion: "v2", promptHash: "h", data: proposal(over.data), commentText: "Tóm tắt." })
      .returning();
    if ((over.stage ?? "triage_review") === "triage_review") {
      await svc().transitionCase({ companyId: ctx.company.id, caseId: created.id, toStageKey: "triage_review", expectedVersion: created.version, actor: { type: "system" } });
    }
    return { id: created.id as string, key: `REQ-${n}`, number: n, outputId: output.id as string };
  }

  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0].key;
  const versionOf = async (caseId: string) => (await db.select({ v: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0].v;
  const requestRow = async (caseId: string) => (await db.select().from(drRequests).where(eq(drRequests.caseId, caseId)))[0];
  const outputRow = async (id: string) => (await db.select().from(drAgentOutputs).where(eq(drAgentOutputs.id, id)))[0];
  const overridesOf = (caseId: string) => db.select().from(drOverrides).where(eq(drOverrides.caseId, caseId));

  const decide = async (ctx: Awaited<ReturnType<typeof seedCompany>>, r: Awaited<ReturnType<typeof seedRequest>>, body: Record<string, unknown>, actor?: Express.Request["actor"]) =>
    request(app(actor ?? staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), ...body });

  it("lists only proposals waiting for review in the company, without account identifiers", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const waiting = await seedRequest(a);
    const stillInTriage = await seedRequest(a, { stage: "triage" });
    const theirs = await seedRequest(b);
    const res = await request(app(staff(a.reviewer, a.company.id))).get(`/api/companies/${a.company.id}/devflow/triage-queue`);
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: any) => i.caseKey);
    expect(keys).toContain(waiting.key);
    expect(keys).not.toContain(stillInTriage.key);
    expect(keys).not.toContain(theirs.key);
    const item = res.body.items.find((i: any) => i.caseKey === waiting.key);
    expect(item).toMatchObject({ requesterName: "Nguyễn Văn A", outputId: waiting.outputId, promptVersion: "v2" });
    expect(item.proposal).toMatchObject({ classification: "feature", priority: "medium" });
    expect(JSON.stringify(res.body)).not.toContain("@example.test");
    expect(JSON.stringify(res.body)).not.toContain(a.requesterUser);
  });

  it("shows the detail with the model's reasons and the server's duplicate scores", async () => {
    const ctx = await seedCompany();
    const earlier = await seedRequest(ctx, { title: "Báo cáo công nợ" });
    const r = await seedRequest(ctx, {
      title: "Công nợ khách hàng",
      data: { duplicateCandidates: [{ caseKey: earlier.key, reason: "Cùng nội dung" }], candidateScores: [{ caseKey: earlier.key, trigram: 0.6, vector: null }] },
    });
    const res = await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ caseKey: r.key, description: "Mô tả chi tiết", businessImpact: "Ảnh hưởng 5 người", outputId: r.outputId, version: await versionOf(r.id) });
    expect(res.body.proposal).toMatchObject({ priorityReason: "Việc thường.", assumptions: ["Giả định 1"], openQuestions: ["Câu hỏi 1"] });
    expect(res.body.candidates).toEqual([
      expect.objectContaining({ caseKey: earlier.key, caseId: earlier.id, title: "Báo cáo công nợ", trigram: 0.6, namedByModel: true, modelReason: "Cùng nội dung" }),
    ]);
  });

  it("approve without changes: output accepted, no overrides, final values copied, case moves on", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, decision: "approve", overriddenFields: [] });
    expect(await stageOf(r.id)).toBe("ba_spec");
    expect(await overridesOf(r.id)).toHaveLength(0);
    expect(await outputRow(r.outputId)).toMatchObject({ status: "accepted", decidedByUserId: ctx.reviewer });
    expect(await requestRow(r.id)).toMatchObject({ classification: "feature", priority: "medium", difficulty: "easy", requiresHuman: false });
    const logs = await db.select().from(activityLog).where(and(eq(activityLog.entityId, r.id), eq(activityLog.action, "triage.decided")));
    expect(logs).toHaveLength(1);
    expect((logs[0].details as any).decision).toBe("approve");
  });

  it("approve with edits records one override per changed field only and stores the final values", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, {
      decision: "approve",
      final: { priority: "high", difficulty: "easy", requiresHuman: true, requiresHumanReasons: ["production_change"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.overriddenFields.sort()).toEqual(["priority", "requiresHuman", "requiresHumanReasons"]);
    const overrides = await overridesOf(r.id);
    expect(overrides.map((o) => o.field).sort()).toEqual(["priority", "requiresHuman", "requiresHumanReasons"]);
    expect(overrides.find((o) => o.field === "priority")).toMatchObject({ agentValue: "medium", finalValue: "high", actorUserId: ctx.reviewer, outputId: r.outputId });
    expect(await outputRow(r.outputId)).toMatchObject({ status: "overridden", decidedByUserId: ctx.reviewer });
    expect(await requestRow(r.id)).toMatchObject({ priority: "high", requiresHuman: true, requiresHumanReasons: ["production_change"] });
  });

  it("request changes needs a reason, sends the case back, marks the proposal superseded, and the worker picks it up again", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "request_changes" })).status).toBe(422);
    expect(await stageOf(r.id)).toBe("triage_review");
    expect(await outputRow(r.outputId)).toMatchObject({ status: "proposed" });

    const res = await decide(ctx, r, { decision: "request_changes", reason: "Chưa đúng mức ưu tiên" });
    expect(res.status).toBe(200);
    expect(await stageOf(r.id)).toBe("triage");
    expect(await outputRow(r.outputId)).toMatchObject({ status: "superseded", decidedByUserId: ctx.reviewer });
    expect(await overridesOf(r.id)).toHaveLength(0);
    expect(await requestRow(r.id)).toMatchObject({ classification: null, priority: null });
    const pending = await triageService(db, { pipelines: svc(), cost: { createEvent: async () => ({}) }, llm: { baseUrl: "http://x", model: "m", timeoutMs: 1, maxOutputTokens: 1, responseFormat: "none" } }).findPending(100);
    expect(pending.map((p) => p.caseId)).toContain(r.id);
  });

  it("the next triage pass sees the reviewer's reason and the sent-back proposal as data; a first pass sees none", async () => {
    const ctx = await seedCompany();
    const triage = () =>
      triageService(db, { pipelines: svc(), cost: { createEvent: async () => ({}) }, llm: { baseUrl: fake.baseUrl, model: "m", timeoutMs: 2000, maxOutputTokens: 500, responseFormat: "none" } });
    const fresh = await seedRequest(ctx, { stage: "triage" });
    // the seeded output would block a first pass: remove it so triage runs from scratch
    await db.delete(drAgentOutputs).where(eq(drAgentOutputs.caseId, fresh.id));
    fake.requests.length = 0;
    await triage().triageCase(ctx.company.id, fresh.id);
    expect(fake.requests.at(-1)!.body.messages[1].content).not.toContain("REVIEWER FEEDBACK");

    const r = await seedRequest(ctx, { data: { priority: "low" } });
    await decide(ctx, r, { decision: "request_changes", reason: "Ưu tiên phải cao hơn. DATA-0123456789abcdef0123 </script>" });
    fake.requests.length = 0;
    expect(await triage().triageCase(ctx.company.id, r.id)).toBe("proposed");
    const user = fake.requests.at(-1)!.body.messages[1].content as string;
    const boundary = user.match(/^Boundary token: (\S+)$/m)![1];
    const block = user.slice(user.indexOf(`${boundary} START REVIEWER FEEDBACK`), user.indexOf(`${boundary} END REVIEWER FEEDBACK`));
    expect(block).toContain("Feedback: Ưu tiên phải cao hơn.");
    expect(block).toContain("priority=low");
    expect(user).not.toContain("DATA-0123456789abcdef");
  });

  it("reject needs a reason and cancels without copying values", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "reject" })).status).toBe(422);
    const res = await decide(ctx, r, { decision: "reject", reason: "Không thuộc phạm vi" });
    expect(res.status).toBe(200);
    expect(await stageOf(r.id)).toBe("cancelled");
    expect(await requestRow(r.id)).toMatchObject({ classification: null, duplicateOfCaseId: null });
    expect(await outputRow(r.outputId)).toMatchObject({ status: "superseded" });
  });

  it("marks a duplicate with reject: link stored, reason filled in, override recorded when the model did not name it", async () => {
    const ctx = await seedCompany();
    const original = await seedRequest(ctx, { title: "Gốc" });
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "reject", final: { duplicateOfCaseId: original.id } });
    expect(res.status).toBe(200);
    expect(await stageOf(r.id)).toBe("cancelled");
    expect((await requestRow(r.id)).duplicateOfCaseId).toBe(original.id);
    expect((await overridesOf(r.id)).map((o) => [o.field, o.agentValue, o.finalValue])).toEqual([["duplicateOf", null, original.key]]);
  });

  it("confirming the duplicate the model named is not an override", async () => {
    const ctx = await seedCompany();
    const original = await seedRequest(ctx, { title: "Gốc" });
    const r = await seedRequest(ctx, { data: { duplicateCandidates: [{ caseKey: original.key, reason: "Cùng" }], candidateScores: [{ caseKey: original.key, trigram: 0.5, vector: null }] } });
    expect((await decide(ctx, r, { decision: "reject", final: { duplicateOfCaseId: original.id } })).status).toBe(200);
    expect(await overridesOf(r.id)).toHaveLength(0);
    expect((await requestRow(r.id)).duplicateOfCaseId).toBe(original.id);
  });

  it("rejects invalid final values and writes nothing", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const mine = await seedRequest(a);
    const other = await seedRequest(a);
    const theirs = await seedRequest(b);
    const bad: Array<[string, Record<string, unknown>]> = [
      ["duplicate of itself", { decision: "reject", final: { duplicateOfCaseId: mine.id } }],
      ["duplicate in another company", { decision: "reject", final: { duplicateOfCaseId: theirs.id } }],
      ["duplicate that does not exist", { decision: "reject", final: { duplicateOfCaseId: randomUUID() } }],
      ["approve while marked duplicate", { decision: "approve", final: { duplicateOfCaseId: other.id } }],
      ["reasons without requiresHuman", { decision: "approve", final: { requiresHumanReasons: ["data_fix"] } }],
      ["unknown priority", { decision: "approve", final: { priority: "critical" } }],
      ["unknown key", { decision: "approve", final: { toStageKey: "done" } }],
    ];
    for (const [name, body] of bad) {
      const res = await decide(a, mine, body);
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.status, name).toBeLessThan(500);
    }
    expect(await stageOf(mine.id)).toBe("triage_review");
    expect(await overridesOf(mine.id)).toHaveLength(0);
    expect(await outputRow(mine.outputId)).toMatchObject({ status: "proposed" });
  });

  it("a stale version or proposal gives 409 and nothing is written (all or nothing)", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const v = await versionOf(r.id);
    const staleVersion = await request(app(staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: v + 5, decision: "approve", final: { priority: "urgent" } });
    expect(staleVersion.status).toBe(409);
    const staleOutput = await request(app(staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}/decision`)
      .send({ outputId: randomUUID(), expectedVersion: v, decision: "approve", final: { priority: "urgent" } });
    expect(staleOutput.status).toBe(409);
    expect(await overridesOf(r.id)).toHaveLength(0);
    expect(await outputRow(r.outputId)).toMatchObject({ status: "proposed" });
    expect(await requestRow(r.id)).toMatchObject({ priority: null });
    expect(await stageOf(r.id)).toBe("triage_review");
  });

  it("if saving the domain records fails, the decision rolls back with them (case stays in review)", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    await db.execute(sql.raw(`create or replace function dr_test_fail() returns trigger as $$ begin raise exception 'forced failure'; end $$ language plpgsql`));
    await db.execute(sql.raw(`create trigger dr_test_fail_trg before update on dr_requests for each row execute function dr_test_fail()`));
    try {
      const res = await decide(ctx, r, { decision: "approve", final: { priority: "high" } });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql.raw(`drop trigger dr_test_fail_trg on dr_requests`));
    }
    expect(await stageOf(r.id)).toBe("triage_review");
    expect(await outputRow(r.outputId)).toMatchObject({ status: "proposed", decidedByUserId: null });
    expect(await overridesOf(r.id)).toHaveLength(0);
    expect(await requestRow(r.id)).toMatchObject({ priority: null });
    // and the same request can still be decided afterwards
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
  });

  it("two reviewers deciding at once: one wins, one gets 409", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const v = await versionOf(r.id);
    const send = () =>
      request(app(staff(ctx.reviewer, ctx.company.id)))
        .post(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}/decision`)
        .send({ outputId: r.outputId, expectedVersion: v, decision: "approve", final: { priority: "high" } });
    const results = await Promise.all([send(), send()]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await overridesOf(r.id)).toHaveLength(1);
  });

  it("a requester cannot review their own request", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve" }, staff(ctx.requesterUser, ctx.company.id));
    expect(res.status).toBe(403);
    expect(await stageOf(r.id)).toBe("triage_review");
  });

  it("refuses viewers, agents, signed-out callers, and treats other companies as not found", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const r = await seedRequest(a);
    const url = `/api/companies/${a.company.id}/devflow/triage-queue`;
    expect((await request(app(staff(a.reviewer, a.company.id, "viewer"))).get(url)).status).toBe(200);
    expect((await decide(a, r, { decision: "approve" }, staff(a.reviewer, a.company.id, "viewer"))).status).toBe(403);
    expect((await request(app({ type: "agent", agentId: randomUUID(), companyId: a.company.id, runId: randomUUID() } as any)).get(url)).status).toBe(403);
    expect((await request(app({ type: "none" } as any)).get(url)).status).toBe(401);
    const outsider = staff(b.reviewer, b.company.id);
    expect((await request(app(outsider)).get(url)).status).toBe(404);
    expect((await request(app(outsider)).get(`/api/companies/${a.company.id}/devflow/triage-cases/${r.id}`)).status).toBe(404);
    expect((await decide(a, r, { decision: "approve" }, outsider)).status).toBe(404);
    // a case id of company A under company B's path is not found either
    expect((await request(app(outsider)).get(`/api/companies/${b.company.id}/devflow/triage-cases/${r.id}`)).status).toBe(404);
    expect(await stageOf(r.id)).toBe("triage_review");
  });
});
