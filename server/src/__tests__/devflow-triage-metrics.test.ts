import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  createDb,
  drAgentOutputs,
  drOverrides,
  drRequesters,
  drRequests,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { triageMetricsService } from "../devflow/triage-review/metrics.js";
import { triageReviewRoutes } from "../devflow/triage-review/routes.js";

// Step 9: override rate, corrections, decisions, flow times, agent health. Numbers are checked against
// hand-built data with fixed timestamps, per company and per window.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow triage metrics", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-metrics-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const DAY = 24 * 60;

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Metrics Co", issuePrefix: `X${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline.id, key: "triage", name: "Triage", kind: "working", position: 100 },
        { pipelineId: pipeline.id, key: "triage_review", name: "Triage Review", kind: "review", position: 150, config: { approveToStageKey: "triage", rejectToStageKey: "triage" } },
      ])
      .returning();
    const stage = Object.fromEntries(stages.map((s) => [s.key, s.id])) as Record<string, string>;
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "A", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company.id, userId }).returning();
    return { company, pipeline, stage, userId, requester };
  }

  let counter = 0;
  /** A request with one triage output. `caseAgo` is when it was filed, `outAgo` when the output was written. */
  async function seedOutput(
    ctx: Awaited<ReturnType<typeof seedCompany>>,
    o: {
      status: "proposed" | "accepted" | "overridden" | "superseded";
      version?: string;
      caseAgo?: number;
      outAgo?: number;
      decidedAgo?: number;
      stage?: "triage" | "triage_review";
      data?: Record<string, unknown>;
      overrides?: Array<[string, unknown, unknown]>;
      duplicateOf?: string;
    },
  ) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: `Yêu cầu ${n}`,
      stageKey: "triage",
      actor: { type: "user", userId: ctx.userId },
    });
    await db.update(pipelineCases).set({ createdAt: ago(o.caseAgo ?? 300), stageId: ctx.stage[o.stage ?? "triage_review"] }).where(eq(pipelineCases.id, created.id));
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "d", duplicateOfCaseId: o.duplicateOf ?? null });
    const decided = o.status === "proposed" ? null : ago(o.decidedAgo ?? 10);
    const [out] = await db
      .insert(drAgentOutputs)
      .values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey: "triage",
        promptRole: "triage",
        promptVersion: o.version ?? "v3",
        promptHash: "h",
        data: o.data ?? { duplicateCandidates: [] },
        commentText: "c",
        status: o.status,
        createdAt: ago(o.outAgo ?? 200),
        decidedAt: decided,
        decidedByUserId: decided ? ctx.userId : null,
      })
      .returning();
    for (const [field, a, b] of o.overrides ?? []) {
      await db.insert(drOverrides).values({ companyId: ctx.company.id, caseId: created.id, outputId: out.id, stageKey: "triage", field, agentValue: a, finalValue: b, actorUserId: ctx.userId });
    }
    return { id: created.id as string, outputId: out.id as string };
  }

  const reviewEvent = (ctx: Awaited<ReturnType<typeof seedCompany>>, caseId: string, decision: string, minutesAgo = 5) =>
    db.insert(pipelineCaseEvents).values({
      companyId: ctx.company.id,
      caseId,
      type: "review_decided",
      actorType: "user",
      actorUserId: ctx.userId,
      fromStageId: ctx.stage.triage_review,
      payload: { decision },
      createdAt: ago(minutesAgo),
    });

  it("is all zeros and null rates for a company with no triage history", async () => {
    const ctx = await seedCompany();
    const m = await triageMetricsService(db).metrics(ctx.company.id, 30);
    expect(m.approved).toMatchObject({ total: 0, overridden: 0, overrideRate: null, byPromptVersion: [] });
    expect(m.fields.every((f) => f.overrides === 0 && f.rate === null)).toBe(true);
    expect(m.decisions).toEqual({ approve: 0, reject: 0, requestChanges: 0 });
    expect(m.flow.secondsToProposal).toEqual({ p50: null, p90: null });
    expect(m.queue).toEqual({ waiting: 0, oldestSince: null });
    expect(m.agent).toMatchObject({ proposed: 0, failed: 0, calls: 0, inputTokens: 0 });
  });

  it("override rate, per field and per prompt version, inside the window only", async () => {
    const ctx = await seedCompany();
    await seedOutput(ctx, { status: "accepted", version: "v2" });
    await seedOutput(ctx, { status: "overridden", version: "v2", overrides: [["priority", "medium", "high"], ["requiresHuman", false, true]] });
    await seedOutput(ctx, { status: "overridden", version: "v3", overrides: [["priority", "medium", "low"], ["difficulty", "easy", "medium"]] });
    await seedOutput(ctx, { status: "accepted", version: "v3" });
    await seedOutput(ctx, { status: "accepted", version: "v3", decidedAgo: 10 * DAY }); // outside a 7-day window
    await seedOutput(ctx, { status: "superseded" }); // sent back or rejected: not an approval

    const m = await triageMetricsService(db).metrics(ctx.company.id, 7);
    expect(m.approved).toMatchObject({ total: 4, overridden: 2, overrideRate: 0.5 });
    expect(m.approved.byPromptVersion).toEqual([
      { promptVersion: "v2", total: 2, overridden: 1, overrideRate: 0.5 },
      { promptVersion: "v3", total: 2, overridden: 1, overrideRate: 0.5 },
    ]);
    const field = (f: string) => m.fields.find((x) => x.field === f)!;
    expect(field("priority")).toMatchObject({ overrides: 2, rate: 0.5 });
    expect(field("difficulty")).toMatchObject({ overrides: 1, rate: 0.25 });
    expect(field("requiresHuman")).toMatchObject({ overrides: 1, rate: 0.25 });
    expect(field("classification")).toMatchObject({ overrides: 0, rate: 0 });

    const wide = await triageMetricsService(db).metrics(ctx.company.id, 30);
    expect(wide.approved.total).toBe(5);
  });

  it("lists the most common corrections, biggest first", async () => {
    const ctx = await seedCompany();
    for (let i = 0; i < 3; i++) await seedOutput(ctx, { status: "overridden", overrides: [["priority", "medium", "high"]] });
    await seedOutput(ctx, { status: "overridden", overrides: [["priority", "low", "medium"], ["classification", "request", "bug"]] });
    await seedOutput(ctx, { status: "overridden", overrides: [["requiresHuman", false, true]] });
    const m = await triageMetricsService(db).metrics(ctx.company.id, 30);
    expect(m.commonCorrections[0]).toEqual({ field: "priority", agentValue: "medium", finalValue: "high", count: 3 });
    expect(m.commonCorrections.map((c) => c.field)).not.toContain("requiresHuman");
    expect(m.commonCorrections).toHaveLength(3);
  });

  it("counts decisions from the review events and duplicate handling", async () => {
    const ctx = await seedCompany();
    const original = await seedOutput(ctx, { status: "proposed" });
    const a = await seedOutput(ctx, { status: "accepted" });
    const b = await seedOutput(ctx, { status: "superseded", duplicateOf: original.id, data: { duplicateCandidates: [{ caseKey: "REQ-1", reason: "x" }] } });
    const c = await seedOutput(ctx, { status: "superseded", duplicateOf: original.id, overrides: [["duplicateOf", null, "REQ-1"]] });
    const d = await seedOutput(ctx, { status: "superseded" });
    await reviewEvent(ctx, a.id, "approve");
    await reviewEvent(ctx, b.id, "reject");
    await reviewEvent(ctx, c.id, "reject");
    await reviewEvent(ctx, d.id, "request_changes");
    await reviewEvent(ctx, d.id, "request_changes", 3 * DAY);
    await reviewEvent(ctx, a.id, "approve", 40 * DAY); // outside the window
    // a decision taken in another stage (not the triage review) is not a triage decision
    await db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId: a.id, type: "review_decided", actorType: "user", actorUserId: ctx.userId, fromStageId: ctx.stage.triage, payload: { decision: "approve" } });
    const m = await triageMetricsService(db).metrics(ctx.company.id, 30);
    expect(m.decisions).toEqual({ approve: 1, reject: 2, requestChanges: 2 });
    expect(m.duplicates).toEqual({ namedByAgent: 1, addedByReviewer: 1, closedAsDuplicate: 2 });
  });

  it("flow times: median and 90th percentile to proposal, in review, and to approval", async () => {
    const ctx = await seedCompany();
    // filed 300 min ago; proposal after 1 min, 3 min and 9 min; decided 20, 40 and 60 min after the proposal
    await seedOutput(ctx, { status: "accepted", caseAgo: 300, outAgo: 299, decidedAgo: 299 - 20 });
    await seedOutput(ctx, { status: "accepted", caseAgo: 300, outAgo: 297, decidedAgo: 297 - 40 });
    await seedOutput(ctx, { status: "accepted", caseAgo: 300, outAgo: 291, decidedAgo: 291 - 60 });
    const m = await triageMetricsService(db).metrics(ctx.company.id, 30);
    expect(m.flow.secondsToProposal.p50!).toBeCloseTo(180, -1);
    expect(m.flow.secondsToProposal.p90!).toBeGreaterThan(m.flow.secondsToProposal.p50!);
    expect(m.flow.secondsInReview.p50!).toBeCloseTo(40 * 60, -1);
    expect(m.flow.secondsInReview.p90!).toBeCloseTo(56 * 60, -1);
    expect(m.flow.secondsToApproval.p50!).toBeCloseTo(43 * 60, -1);
  });

  it("queue: only proposals waiting in review, with the oldest one", async () => {
    const ctx = await seedCompany();
    await seedOutput(ctx, { status: "proposed", outAgo: 120 });
    await seedOutput(ctx, { status: "proposed", outAgo: 30 });
    await seedOutput(ctx, { status: "proposed", outAgo: 500, stage: "triage" }); // not yet submitted for review
    const m = await triageMetricsService(db).metrics(ctx.company.id, 30);
    expect(m.queue.waiting).toBe(2);
    expect(Date.now() - new Date(m.queue.oldestSince!).getTime()).toBeGreaterThan(110 * 60_000);
    expect(Date.now() - new Date(m.queue.oldestSince!).getTime()).toBeLessThan(130 * 60_000);
  });

  it("agent health and tokens, scoped to the company and the window", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const caseA = await seedOutput(a, { status: "proposed" });
    const caseB = await seedOutput(b, { status: "proposed" });
    const log = (ctx: typeof a, caseId: string, action: string, minutesAgo = 5) =>
      db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "devflow-triage", action, entityType: "pipeline_case", entityId: caseId, createdAt: ago(minutesAgo) });
    await log(a, caseA.id, "agent.triage_proposed");
    await log(a, caseA.id, "agent.triage_proposed");
    await log(a, caseA.id, "agent.triage_failed");
    await log(a, caseA.id, "agent.triage_gave_up");
    await log(a, caseA.id, "agent.embed_failed");
    await log(a, caseA.id, "email.failed");
    await log(a, caseA.id, "agent.triage_failed", 60 * DAY); // outside the window
    await log(b, caseB.id, "agent.triage_failed");
    const [agentA] = await db.insert(agents).values({ companyId: a.company.id, name: "DevFlow Triage" }).returning();
    const cost = (agentId: string, companyId: string, code: string, i: number, o: number, minutesAgo = 5) =>
      db.execute(sql`insert into cost_events (company_id, agent_id, usage_kind, provider, biller, billing_type, cost_status, model, input_tokens, output_tokens, cost_cents, billing_code, occurred_at)
                     values (${companyId}, ${agentId}, 'agent', 'p', 'p', 'unknown', 'unpriced', 'm', ${i}, ${o}, 0, ${code}, ${ago(minutesAgo).toISOString()}::timestamptz)`);
    await cost(agentA.id, a.company.id, "devflow:triage", 1000, 900);
    await cost(agentA.id, a.company.id, "devflow:embed", 50, 0);
    await cost(agentA.id, a.company.id, "devflow:triage", 7, 7, 60 * DAY);
    await cost(agentA.id, a.company.id, "other", 999, 999);
    const [agentB] = await db.insert(agents).values({ companyId: b.company.id, name: "DevFlow Triage" }).returning();
    await cost(agentB.id, b.company.id, "devflow:triage", 5000, 5000);
    const m = await triageMetricsService(db).metrics(a.company.id, 30);
    expect(m.agent).toEqual({ proposed: 2, failed: 1, gaveUp: 1, embedFailed: 1, emailFailed: 1, calls: 2, inputTokens: 1050, outputTokens: 900 });
  });

  it("route: staff only, days clamped, other companies not found", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await seedOutput(a, { status: "accepted" });
    const staff = (companyId: string, role = "member"): Express.Request["actor"] => ({
      type: "board",
      source: "session",
      userId: `user-${randomUUID()}`,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }] as any,
      isInstanceAdmin: false,
    });
    const app = (actor: Express.Request["actor"]) => {
      const x = express();
      x.use(express.json());
      x.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      x.use("/api", triageReviewRoutes(db, { reviewCase: (input) => pipelineService(db).reviewCase(input) }));
      x.use(errorHandler);
      return x;
    };
    const url = (id: string, q = "") => `/api/companies/${id}/devflow/triage-metrics${q}`;
    expect((await request(app(staff(a.company.id))).get(url(a.company.id))).body).toMatchObject({ windowDays: 30, approved: { total: 1 } });
    expect((await request(app(staff(a.company.id))).get(url(a.company.id, "?days=0"))).body.windowDays).toBe(30);
    expect((await request(app(staff(a.company.id))).get(url(a.company.id, "?days=99999"))).body.windowDays).toBe(365);
    expect((await request(app(staff(a.company.id))).get(url(a.company.id, "?days=7"))).body.windowDays).toBe(7);
    expect((await request(app(staff(a.company.id, "viewer"))).get(url(a.company.id))).status).toBe(200);
    expect((await request(app(staff(b.company.id))).get(url(a.company.id))).status).toBe(404);
    expect((await request(app({ type: "none" } as any)).get(url(a.company.id))).status).toBe(401);
    expect((await request(app({ type: "agent", agentId: randomUUID(), companyId: a.company.id, runId: randomUUID() } as any)).get(url(a.company.id))).status).toBe(403);
    // company B sees nothing of A's numbers
    expect((await request(app(staff(b.company.id))).get(url(b.company.id))).body.approved.total).toBe(0);
  });
});
