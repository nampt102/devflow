import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, authUsers, companies, createDb, drAgentOutputs, drOverrides, drRequesters, drRequests, pipelineCaseEvents, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { baMetricsService } from "../devflow/ba/metrics.js";
import { baRoutes } from "../devflow/ba/routes.js";

// BA metrics: override rate and corrections, decisions, review time, run cost and failures, checked against
// hand-built data with fixed timestamps, per company and per window.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow BA metrics", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-ba-metrics-");
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
      .values({ name: "BA Metrics Co", issuePrefix: `M${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline!.id, key: "ba_spec", name: "BA Spec", kind: "working", position: 200 },
        { pipelineId: pipeline!.id, key: "ba_review", name: "BA Review", kind: "review", position: 250, config: { approveToStageKey: "ba_spec", rejectToStageKey: "ba_spec" } },
        { pipelineId: pipeline!.id, key: "triage_review", name: "Triage Review", kind: "review", position: 150, config: { approveToStageKey: "ba_spec", rejectToStageKey: "ba_spec" } },
      ])
      .returning();
    const stage = Object.fromEntries(stages.map((s) => [s.key, s.id])) as Record<string, string>;
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "R", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId }).returning();
    return { company: company!, pipeline: pipeline!, stage, userId, requester: requester! };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  /** One request with one BA output: `status`, when it was proposed and decided, and its overrides. */
  async function seedOutput(ctx: Ctx, o: { status: string; version?: string; proposedAgo?: number; decidedAgo?: number; overrides?: string[]; waiting?: boolean }) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({ companyId: ctx.company.id, pipelineId: ctx.pipeline.id, caseKey: `REQ-${n}`, title: `Yêu cầu ${n}`, stageKey: "ba_spec", actor: { type: "user", userId: ctx.userId } });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "d" });
    // a spec sent back by a reviewer is superseded with a decision time; one replaced without a decision has none
    const decided = ["accepted", "overridden"].includes(o.status) || (o.status === "superseded" && o.decidedAgo !== undefined);
    const [out] = await db
      .insert(drAgentOutputs)
      .values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey: "ba_spec",
        promptRole: "ba",
        promptVersion: o.version ?? "v1",
        promptHash: "h",
        data: {},
        commentText: "c",
        status: o.status,
        createdAt: ago(o.proposedAgo ?? 60),
        decidedAt: decided ? ago(o.decidedAgo ?? 30) : null,
        decidedByUserId: decided ? ctx.userId : null,
      })
      .returning();
    for (const field of o.overrides ?? []) {
      await db.insert(drOverrides).values({ companyId: ctx.company.id, caseId: created.id, outputId: out!.id, stageKey: "ba_spec", field, agentValue: "a", finalValue: "b", actorUserId: ctx.userId });
    }
    if (o.waiting) await db.update(pipelineCases).set({ stageId: ctx.stage.ba_review }).where(eq(pipelineCases.id, created.id));
    return { caseId: created.id as string, key: `REQ-${n}` };
  }

  const decision = (ctx: Ctx, caseId: string, d: string, minutesAgo = 10) =>
    db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId, type: "review_decided", actorType: "user", actorId: ctx.userId, fromStageId: ctx.stage.ba_review, payload: { decision: d }, createdAt: ago(minutesAgo) });
  const log = (ctx: Ctx, caseId: string, action: string, details: Record<string, unknown>, minutesAgo = 5) =>
    db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "devflow-ba", action, entityType: "pipeline_case", entityId: caseId, details, createdAt: ago(minutesAgo) });
  const metrics = (companyId: string, days = 30) => baMetricsService(db).metrics(companyId, days);

  it("counts approved specs, overrides per field and by prompt version, inside the window only", async () => {
    const ctx = await seedCompany();
    await seedOutput(ctx, { status: "overridden", overrides: ["acceptanceCriteria", "risks"] });
    await seedOutput(ctx, { status: "overridden", overrides: ["acceptanceCriteria"] });
    await seedOutput(ctx, { status: "accepted" });
    await seedOutput(ctx, { status: "accepted", version: "v2" });
    await seedOutput(ctx, { status: "accepted", decidedAgo: 10 * DAY }); // outside a 7-day window
    await seedOutput(ctx, { status: "superseded", decidedAgo: 20 }); // sent back by a reviewer: decided, but not an approval
    await seedOutput(ctx, { status: "superseded" }); // replaced without a decision
    const m = await metrics(ctx.company.id, 7);
    expect(m.approved).toMatchObject({ total: 4, overridden: 2, overrideRate: 0.5 });
    expect(m.approved.byPromptVersion).toEqual([
      { promptVersion: "v1", total: 3, overridden: 2, overrideRate: 2 / 3 },
      { promptVersion: "v2", total: 1, overridden: 0, overrideRate: 0 },
    ]);
    expect(m.fields).toEqual([
      { field: "acceptanceCriteria", overrides: 2, rate: 0.5 },
      { field: "risks", overrides: 1, rate: 0.25 },
    ]);
    expect((await metrics(ctx.company.id, 30)).approved.total).toBe(5);
  });

  it("counts review decisions, the time specs wait for a decision, and the queue", async () => {
    const ctx = await seedCompany();
    const a = await seedOutput(ctx, { status: "accepted", proposedAgo: 100, decidedAgo: 40 }); // 60 min in review
    const b = await seedOutput(ctx, { status: "accepted", proposedAgo: 100, decidedAgo: 80 }); // 20 min
    await decision(ctx, a.caseId, "approve");
    await decision(ctx, b.caseId, "approve");
    await decision(ctx, a.caseId, "request_changes");
    await decision(ctx, b.caseId, "reject", 20 * DAY); // outside the window
    const waiting = await seedOutput(ctx, { status: "proposed", proposedAgo: 45, waiting: true });
    await seedOutput(ctx, { status: "proposed", proposedAgo: 90 }); // still in ba_spec: not in the review queue
    const triageCase = await seedOutput(ctx, { status: "proposed" });
    await db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId: triageCase.caseId, type: "review_decided", actorType: "user", actorId: ctx.userId, fromStageId: ctx.stage.triage_review, payload: { decision: "approve" }, createdAt: ago(5) }); // another review: not BA's
    const m = await metrics(ctx.company.id, 7);
    expect(m.decisions).toEqual({ approve: 2, reject: 0, requestChanges: 1 });
    expect(m.flow.secondsInReview.p50).toBeCloseTo(40 * 60, -1); // between 20 and 60 minutes
    expect(m.flow.secondsInReview.p90).toBeGreaterThan(m.flow.secondsInReview.p50!);
    expect(m.queue.waiting).toBe(1);
    expect(new Date(m.queue.oldestSince!).getTime()).toBeLessThan(Date.now() - 44 * 60_000);
    expect(waiting.caseId).toBeTruthy();
  });

  it("adds up run cost from the run ledger, failed runs included, and lists recent problems without request text", async () => {
    const ctx = await seedCompany();
    const a = await seedOutput(ctx, { status: "proposed" });
    await log(ctx, a.caseId, "agent.ba_run", { ok: true, costUsd: 0.4, inputTokens: 1000, outputTokens: 200 });
    await log(ctx, a.caseId, "agent.ba_run", { ok: false, kind: "budget_exhausted", costUsd: 1.1, inputTokens: 3000, outputTokens: 100 });
    await log(ctx, a.caseId, "agent.ba_run", { ok: true, costUsd: 0.5, inputTokens: 500, outputTokens: 50 }, 20 * DAY); // outside a 7-day window
    await log(ctx, a.caseId, "agent.ba_proposed", { outputId: "x" });
    await log(ctx, a.caseId, "agent.ba_failed", { kind: "budget_exhausted", attempts: 1, note: "Mô tả bí mật của yêu cầu" }, 4);
    await log(ctx, a.caseId, "agent.ba_gave_up", { kind: "run_failed", attempts: 3 }, 3);
    await log(ctx, a.caseId, "agent.triage_failed", { kind: "timeout" }, 2); // Triage's own problems are not the BA agent's
    const other = await seedCompany();
    await log(other, (await seedOutput(other, { status: "proposed" })).caseId, "agent.ba_run", { ok: true, costUsd: 99 });
    const m = await metrics(ctx.company.id, 7);
    expect(m.agent).toMatchObject({ runs: 2, failedRuns: 1, proposed: 1, failed: 1, gaveUp: 1, budgetPaused: 0, inputTokens: 4000, outputTokens: 300 });
    expect(m.agent.spendUsd).toBeCloseTo(1.5);
    expect(m.agent.avgUsdPerRun).toBeCloseTo(0.75);
    expect(m.recentFailures.map((f) => [f.action, f.kind, f.caseKey])).toEqual([
      ["agent.ba_gave_up", "run_failed", a.key],
      ["agent.ba_failed", "budget_exhausted", a.key],
    ]);
    expect(JSON.stringify(m)).not.toContain("bí mật");
    expect((await metrics(ctx.company.id, 30)).agent.runs).toBe(3);
  });

  it("is empty and honest when nothing has happened", async () => {
    const ctx = await seedCompany();
    const m = await metrics(ctx.company.id);
    expect(m.approved).toEqual({ total: 0, overridden: 0, overrideRate: null, byPromptVersion: [] });
    expect(m.fields).toEqual([]);
    expect(m.agent).toMatchObject({ runs: 0, spendUsd: 0, avgUsdPerRun: null });
    expect(m.flow.secondsInReview).toEqual({ p50: null, p90: null });
    expect(m.queue).toEqual({ waiting: 0, oldestSince: null });
  });

  it("serves it to staff of the company only, with the window kept in range", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await seedOutput(a, { status: "accepted" });
    const staff = (c: Ctx): Express.Request["actor"] => ({ type: "board", source: "session", userId: "u", companyIds: [c.company.id], memberships: [{ companyId: c.company.id, membershipRole: "member", status: "active" }] as any, isInstanceAdmin: false });
    const app = (actor: Express.Request["actor"]) => {
      const x = express();
      x.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      x.use("/api", baRoutes(db, { reviewCase: async () => undefined }, {}));
      x.use(errorHandler);
      return x;
    };
    const url = (c: Ctx, q = "") => `/api/companies/${c.company.id}/devflow/ba-metrics${q}`;
    expect((await request(app(staff(a))).get(url(a))).body.approved.total).toBe(1);
    expect((await request(app(staff(a))).get(url(a, "?days=9999"))).body.windowDays).toBe(365);
    expect((await request(app(staff(a))).get(url(a, "?days=0"))).body.windowDays).toBe(30);
    expect((await request(app(staff(b))).get(url(a))).status).toBe(404);
    expect((await request(app({ type: "none", source: "none" } as any)).get(url(a))).status).toBe(401);
    expect((await request(app({ type: "agent", agentId: randomUUID(), companyId: a.company.id, source: "agent_key" } as any)).get(url(a))).status).toBe(403);
  });
});
