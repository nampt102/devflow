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
  drRequestSystems,
  drRequests,
  drSystems,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { grantRoles, makeOwner, requireRoles } from "./helpers/role-gate.js";
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
    expect(Number.isNaN(new Date(item.proposedAt).getTime())).toBe(false); // when the proposal arrived, for the "New" label and sorting
    expect(item.proposal).toMatchObject({ classification: "feature", priority: "medium" });
    expect(JSON.stringify(res.body)).not.toContain("@example.test");
    expect(JSON.stringify(res.body)).not.toContain(a.requesterUser);
  });

  it("counts waiting proposals for the sidebar badge, scoped to the company and to staff", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await seedRequest(a);
    await seedRequest(a);
    await seedRequest(a, { stage: "triage" }); // not yet submitted for review
    await seedRequest(b);
    const url = (id: string) => `/api/companies/${id}/devflow/triage-count`;
    const res = await request(app(staff(a.reviewer, a.company.id))).get(url(a.company.id));
    expect(res.status).toBe(200);
    expect(res.body.waiting).toBe(2);
    expect(Number.isNaN(new Date(res.body.newest).getTime())).toBe(false);
    expect((await request(app(staff(b.reviewer, b.company.id))).get(url(b.company.id))).body.waiting).toBe(1);
    expect((await request(app(staff(b.reviewer, b.company.id))).get(url(a.company.id))).status).toBe(404);
    expect((await request(app({ type: "none" } as any)).get(url(a.company.id))).status).toBe(401);
    const empty = await seedCompany();
    expect((await request(app(staff(empty.reviewer, empty.company.id))).get(url(empty.company.id))).body).toEqual({ waiting: 0, newest: null });
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

  describe("systems", () => {
    type Ctx = Awaited<ReturnType<typeof seedCompany>>;
    const system = async (ctx: Ctx, key: string, over: Record<string, unknown> = {}) =>
      (await db.insert(drSystems).values({ companyId: ctx.company.id, key, name: key.toUpperCase(), description: `${key} system`, repoUrl: `https://github.com/acme/${key}`, ...over }).returning())[0]!;
    const assignedKeys = async (caseId: string) =>
      (
        await db
          .select({ key: drSystems.key })
          .from(drRequestSystems)
          .innerJoin(drSystems, eq(drSystems.id, drRequestSystems.systemId))
          .where(eq(drRequestSystems.caseId, caseId))
      )
        .map((r) => r.key)
        .sort();

    it("shows the detail with the company's active systems, the suggestion and what is selected", async () => {
      const ctx = await seedCompany();
      const portal = await system(ctx, "portal");
      await system(ctx, "erp");
      await system(ctx, "old", { active: false });
      const other = await seedCompany();
      await system(other, "theirs");
      const r = await seedRequest(ctx, { data: { suggestedSystemKeys: ["portal"] } });
      const res = await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}`);
      expect(res.body.systems.available.map((x: any) => x.key)).toEqual(["erp", "portal"]);
      expect(res.body.systems.available[0]).toEqual({ id: expect.any(String), key: "erp", name: "ERP", description: "erp system" });
      expect(res.body.systems.suggestedKeys).toEqual(["portal"]);
      expect(res.body.systems.selectedIds).toEqual([portal.id]);
      expect(JSON.stringify(res.body)).not.toContain("theirs");
      expect(JSON.stringify(res.body)).not.toContain("repoUrl"); // the repository address and the token stay on the Systems page
    });

    it("approve stores the chosen systems, and an agent without a suggestion has nothing to be corrected", async () => {
      const ctx = await seedCompany();
      const portal = await system(ctx, "portal");
      const r = await seedRequest(ctx); // proposal written by an older prompt: no suggestedSystemKeys
      const res = await decide(ctx, r, { decision: "approve", systemIds: [portal.id] });
      expect(res.status).toBe(200);
      expect(await assignedKeys(r.id)).toEqual(["portal"]);
      expect(res.body.overriddenFields).not.toContain("systems");
      const [row] = await db.select().from(drRequestSystems).where(eq(drRequestSystems.caseId, r.id));
      expect(row!.assignedByUserId).toBe(ctx.reviewer);
    });

    it("without a choice, approve keeps what the agent suggested, and that is not an override", async () => {
      const ctx = await seedCompany();
      await system(ctx, "portal");
      await system(ctx, "erp");
      const r = await seedRequest(ctx, { data: { suggestedSystemKeys: ["portal", "erp"] } });
      const res = await decide(ctx, r, { decision: "approve" });
      expect(res.status).toBe(200);
      expect(await assignedKeys(r.id)).toEqual(["erp", "portal"]);
      expect(await overridesOf(r.id)).toHaveLength(0);
    });

    it("a changed choice is one override with the system keys, and an empty choice is allowed", async () => {
      const ctx = await seedCompany();
      await system(ctx, "portal");
      const erp = await system(ctx, "erp");
      const r = await seedRequest(ctx, { data: { suggestedSystemKeys: ["portal"] } });
      // an earlier assignment (e.g. from a first pass) is replaced, not added to
      const portalRow = (await db.select().from(drSystems).where(and(eq(drSystems.companyId, ctx.company.id), eq(drSystems.key, "portal"))))[0]!;
      await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: r.id, systemId: portalRow.id });
      expect((await decide(ctx, r, { decision: "approve", systemIds: [erp.id] })).body.overriddenFields).toEqual(["systems"]);
      const [ov] = await overridesOf(r.id);
      expect(ov).toMatchObject({ field: "systems", stageKey: "triage", agentValue: ["portal"], finalValue: ["erp"] });
      expect(await assignedKeys(r.id)).toEqual(["erp"]);
      const none = await seedRequest(ctx, { data: { suggestedSystemKeys: ["portal"] } });
      expect((await decide(ctx, none, { decision: "approve", systemIds: [] })).status).toBe(200);
      expect(await assignedKeys(none.id)).toEqual([]);
    });

    it("refuses a system of another company or one that is switched off, and writes nothing", async () => {
      const ctx = await seedCompany();
      const other = await seedCompany();
      const theirs = await system(other, "theirs");
      const off = await system(ctx, "off", { active: false });
      const r = await seedRequest(ctx);
      for (const id of [theirs.id, off.id, randomUUID()]) {
        const res = await decide(ctx, r, { decision: "approve", systemIds: [id] });
        expect(res.status, id).toBe(422);
      }
      expect(await stageOf(r.id)).toBe("triage_review");
      expect(await assignedKeys(r.id)).toEqual([]);
      expect((await outputRow(r.outputId)).status).toBe("proposed");
      expect((await decide(ctx, r, { decision: "approve", systemIds: ["not-a-uuid"] })).status).toBe(400);
    });

    it("reject and request changes leave the assignment alone", async () => {
      const ctx = await seedCompany();
      const portal = await system(ctx, "portal");
      const r = await seedRequest(ctx, { data: { suggestedSystemKeys: ["portal"] } });
      await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: r.id, systemId: portal.id });
      expect((await decide(ctx, r, { decision: "request_changes", reason: "thiếu thông tin", systemIds: [] })).status).toBe(200);
      expect(await assignedKeys(r.id)).toEqual(["portal"]);
    });
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

  it("a decision that loses the race after our checks is a 409, not the core's validation error", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const [baSpec] = await db.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, ctx.pipeline.id), eq(pipelineStages.key, "ba_spec")));
    const racing = express();
    racing.use(express.json());
    racing.use((req, _res, next) => {
      req.actor = staff(ctx.reviewer, ctx.company.id);
      next();
    });
    racing.use(
      "/api",
      triageReviewRoutes(db, {
        // someone else's decision lands right after our checks and before the core transaction
        reviewCase: async (input) => {
          await db.update(pipelineCases).set({ stageId: baSpec.id }).where(eq(pipelineCases.id, r.id));
          return svc().reviewCase(input);
        },
      }),
    );
    racing.use(errorHandler);
    const res = await request(racing)
      .post(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), decision: "approve" });
    expect(res.status).toBe(409);
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

  it("with role approvers, only BA or Tech Lead (or an owner) may decide, and the screen says so", async () => {
    const ctx = await seedCompany();
    await requireRoles(db, ctx.pipeline.id, "triage_review", ["ba", "tech_lead"]);
    const r = await seedRequest(ctx);
    const detail = async (actor?: Express.Request["actor"]) =>
      (await request(app(actor ?? staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}`)).body;
    expect(await detail()).toMatchObject({ canDecide: false, requiredRoles: ["ba", "tech_lead"] });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    expect(await stageOf(r.id)).toBe("triage_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    expect(await overridesOf(r.id)).toHaveLength(0);

    await grantRoles(db, ctx.company.id, ctx.reviewer, ["ba"]);
    expect(await detail()).toMatchObject({ canDecide: true });
    const owner = `user-${randomUUID()}`;
    await makeOwner(db, ctx.company.id, owner);
    expect(await detail(staff(owner, ctx.company.id, "owner"))).toMatchObject({ canDecide: true });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("ba_spec");
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

  describe("snooze (change add-triage-snooze)", () => {
    const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10); // a day in Vietnam
    const url = (ctx: Awaited<ReturnType<typeof seedCompany>>, r: Awaited<ReturnType<typeof seedRequest>>) => `/api/companies/${ctx.company.id}/devflow/triage-cases/${r.id}/snooze`;
    const snooze = async (ctx: Awaited<ReturnType<typeof seedCompany>>, r: Awaited<ReturnType<typeof seedRequest>>, body: Record<string, unknown>, actor?: Express.Request["actor"]) =>
      request(app(actor ?? staff(ctx.reviewer, ctx.company.id))).post(url(ctx, r)).send({ expectedVersion: await versionOf(r.id), until: day(7), ...body });
    const queueKeys = async (ctx: Awaited<ReturnType<typeof seedCompany>>) =>
      (await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-queue`)).body.items.map((i: any) => i.caseKey);
    const count = async (ctx: Awaited<ReturnType<typeof seedCompany>>) =>
      (await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-count`)).body.waiting;

    it("hides a snoozed request from the queue and the count without moving it, and lists it as snoozed", async () => {
      const ctx = await seedCompany();
      const r = await seedRequest(ctx);
      const other = await seedRequest(ctx);
      const res = await snooze(ctx, r, { note: "Chờ ngân sách" });
      expect(res.status).toBe(200);
      expect(await queueKeys(ctx)).toEqual([other.key]);
      expect(await count(ctx)).toBe(1);
      expect(await stageOf(r.id)).toBe("triage_review");
      const list = await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-snoozed`);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ caseKey: r.key, note: "Chờ ngân sách" });
      expect(Date.parse(list.body.items[0].snoozedUntil)).toBeGreaterThan(Date.now());
    });

    it("brings the request back by itself when the day comes, labelled as new", async () => {
      const ctx = await seedCompany();
      const r = await seedRequest(ctx);
      await snooze(ctx, r, {});
      expect(await queueKeys(ctx)).toEqual([]);
      const back = new Date(Date.now() - 1000);
      await db.update(drRequests).set({ snoozedUntil: back }).where(eq(drRequests.caseId, r.id));
      expect(await queueKeys(ctx)).toEqual([r.key]);
      expect(await count(ctx)).toBe(1);
      const item = (await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-queue`)).body.items[0];
      expect(Date.parse(item.proposedAt)).toBeGreaterThanOrEqual(back.getTime());
      const list = await request(app(staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/triage-snoozed`);
      expect(list.body.items).toEqual([]);
    });

    it("refuses a day that is today, past, malformed or more than 90 days away", async () => {
      const ctx = await seedCompany();
      const r = await seedRequest(ctx);
      for (const until of [day(0), day(-3), "soon", "2026-13-40"]) expect((await snooze(ctx, r, { until })).status, until).toBeGreaterThanOrEqual(400);
      expect((await snooze(ctx, r, { until: day(91) })).status).toBe(422);
      expect((await snooze(ctx, r, { until: day(90) })).status).toBe(200);
    });

    it("refuses when the request changed, is not in review, or is the viewer's own; needs the role the stage asks for", async () => {
      const ctx = await seedCompany();
      const r = await seedRequest(ctx);
      expect((await snooze(ctx, r, { expectedVersion: (await versionOf(r.id)) + 5 })).status).toBe(409);
      const inTriage = await seedRequest(ctx, { stage: "triage" });
      expect((await snooze(ctx, inTriage, {})).status).toBe(409);
      expect((await snooze(ctx, r, {}, staff(ctx.requesterUser, ctx.company.id))).status).toBe(403);
      expect((await snooze(ctx, r, {}, staff(ctx.reviewer, ctx.company.id, "viewer"))).status).toBe(403);
      expect(await queueKeys(ctx)).toContain(r.key);
    });

    it("lets a reviewer bring it back early, and a decision ends the snooze", async () => {
      const ctx = await seedCompany();
      const r = await seedRequest(ctx);
      await snooze(ctx, r, {});
      const early = await request(app(staff(ctx.reviewer, ctx.company.id))).delete(url(ctx, r));
      expect(early.body).toMatchObject({ ok: true, changed: true });
      expect(await queueKeys(ctx)).toEqual([r.key]);
      expect((await request(app(staff(ctx.reviewer, ctx.company.id))).delete(url(ctx, r))).body.changed).toBe(false);

      const d = await seedRequest(ctx);
      await snooze(ctx, d, {});
      // a person who reviews it anyway (from a link): the decision clears the snooze
      expect((await decide(ctx, d, { decision: "approve" })).status).toBe(200);
      const row = await requestRow(d.id);
      expect([row.snoozedUntil, row.snoozedBy, row.snoozeNote]).toEqual([null, null, null]);
    });

    it("keeps one company's snoozed list to itself", async () => {
      const a = await seedCompany();
      const b = await seedCompany();
      const r = await seedRequest(a);
      await snooze(a, r, {});
      const res = await request(app(staff(b.reviewer, b.company.id))).get(`/api/companies/${b.company.id}/devflow/triage-snoozed`);
      expect(res.body.items).toEqual([]);
      expect((await snooze(a, r, {}, staff(b.reviewer, b.company.id))).status).toBe(404);
    });
  });
});
