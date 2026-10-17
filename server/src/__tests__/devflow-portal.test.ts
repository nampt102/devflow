import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  createDb,
  drRequestCounters,
  drRequesters,
  drRequests,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { portalRoutes } from "../devflow/portal/routes.js";
import { MAX_REQUESTS_PER_HOUR } from "../devflow/portal/portal-service.js";

// Requester isolation and DTO allowlist for the intake portal (openspec/changes/add-intake-portal).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow portal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-portal-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const sessionActor = (userId: string): Express.Request["actor"] => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [],
    memberships: [],
    isInstanceAdmin: false,
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    instance.use("/api", portalRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db
      .insert(pipelines)
      .values({ companyId: company.id, key: "dev-request", name: "Dev Request" })
      .returning();
    const [triage, review] = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline.id, key: "triage", name: "Triage", kind: "working", position: 100 },
        {
          pipelineId: pipeline.id,
          key: "triage_review",
          name: "Triage Review",
          kind: "review",
          position: 150,
          config: { approveToStageKey: "triage", rejectToStageKey: "triage" },
        },
      ])
      .returning();
    return { company, pipeline, triage, review };
  }

  async function seedRequester(companyId: string, opts: { deactivated?: boolean } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Người dùng",
      email: `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    const [requester] = await db
      .insert(drRequesters)
      .values({ companyId, userId, deactivatedAt: opts.deactivated ? now : null })
      .returning();
    return { userId, requester };
  }

  const submit = (actor: Express.Request["actor"], body: Record<string, unknown> = {}, qs = "") =>
    request(app(actor))
      .post(`/api/portal/requests${qs}`)
      .send({ title: "Cần báo cáo tồn kho", description: "Mô tả chi tiết", ...body });

  it("rejects users who are not requesters, and non-session actors", async () => {
    await seedCompany("No Requester Co");
    const stranger = sessionActor(`user-${randomUUID()}`);
    expect((await request(app(stranger)).get("/api/portal/me")).status).toBe(403);
    expect((await submit(stranger)).status).toBe(403);
    expect((await request(app({ type: "none" })).get("/api/portal/me")).status).toBe(401);
    expect((await request(app({ type: "agent", agentId: randomUUID(), companyId: randomUUID() })).get("/api/portal/me")).status).toBe(401);
  });

  it("rejects a deactivated requester", async () => {
    const { company } = await seedCompany("Deactivated Co");
    const { userId } = await seedRequester(company.id, { deactivated: true });
    expect((await request(app(sessionActor(userId))).get("/api/portal/me")).status).toBe(403);
  });

  it("submits requests as the requester with sequential REQ codes and a fixed stage", async () => {
    const { company, pipeline } = await seedCompany("Submit Co");
    const { userId, requester } = await seedRequester(company.id);
    const actor = sessionActor(userId);

    const first = await submit(actor, { stageKey: "triage_review", priority: "urgent", fields: { hack: true } });
    expect(first.status).toBe(201);
    expect(first.body.code).toBe("REQ-1");
    expect(first.body.statusLabel).toBe("Đã tiếp nhận");
    const second = await submit(actor, { title: "Yêu cầu thứ hai" });
    expect(second.body.code).toBe("REQ-2");

    // a made-up companyId from the client is refused, never trusted
    expect((await submit(actor, {}, `?companyId=${randomUUID()}`)).status).toBe(403);

    const [kase] = await db.select().from(pipelineCases).where(and(eq(pipelineCases.companyId, company.id), eq(pipelineCases.caseKey, "REQ-1")));
    expect(kase.companyId).toBe(company.id);
    expect(kase.pipelineId).toBe(pipeline.id);
    expect(kase.fields).toEqual({});
    const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, kase.stageId));
    expect(stage.key).toBe("triage");
    const [row] = await db.select().from(drRequests).where(eq(drRequests.caseId, kase.id));
    expect(row.requesterId).toBe(requester.id);
    expect(row.priority).toBeNull();
    const events = await db.select().from(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, kase.id));
    expect(events.every((e) => e.actorType === "user" && e.actorUserId === userId)).toBe(true);
  });

  it("validates input and rate-limits submissions", async () => {
    const { company } = await seedCompany("Limit Co");
    const { userId } = await seedRequester(company.id);
    const actor = sessionActor(userId);
    expect((await submit(actor, { title: "" })).status).toBe(400);
    expect((await submit(actor, { description: "x".repeat(8_001) })).status).toBe(400);
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) expect((await submit(actor)).status).toBe(201);
    expect((await submit(actor)).status).toBe(429);
  });

  it("returns only the allowlisted fields, never agent or internal data", async () => {
    const { company } = await seedCompany("Dto Co");
    const { userId } = await seedRequester(company.id);
    const actor = sessionActor(userId);
    await submit(actor);
    await db
      .update(pipelineCases)
      .set({
        fields: { internalNote: "SECRET-FIELD" },
        pendingSuggestion: { id: randomUUID(), toStageKey: "triage_review", rationale: "SECRET-RATIONALE", createdAt: new Date().toISOString() },
      })
      .where(and(eq(pipelineCases.companyId, company.id), eq(pipelineCases.caseKey, "REQ-1")));

    const detail = await request(app(actor)).get("/api/portal/requests/1");
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body).sort()).toEqual(
      ["businessImpact", "code", "createdAt", "description", "number", "statusLabel", "title", "updatedAt"],
    );
    const list = await request(app(actor)).get("/api/portal/requests");
    for (const body of [JSON.stringify(detail.body), JSON.stringify(list.body)]) {
      expect(body).not.toMatch(/SECRET|pendingSuggestion|fields|events|stageId|caseId/);
    }
  });

  it("maps the current stage to a Vietnamese status label", async () => {
    const { company, review } = await seedCompany("Label Co");
    const { userId } = await seedRequester(company.id);
    const actor = sessionActor(userId);
    await submit(actor);
    await db.update(pipelineCases).set({ stageId: review.id }).where(and(eq(pipelineCases.companyId, company.id), eq(pipelineCases.caseKey, "REQ-1")));
    const detail = await request(app(actor)).get("/api/portal/requests/1");
    expect(detail.body.statusLabel).toBe("Đang chờ duyệt phân loại");
  });

  it("isolates requesters from each other, across companies, and from the board API", async () => {
    const a = await seedCompany("Isolation A");
    const b = await seedCompany("Isolation B");
    const ra = await seedRequester(a.company.id);
    const rb = await seedRequester(a.company.id); // same company, other requester
    const rc = await seedRequester(b.company.id); // other company
    await submit(sessionActor(ra.userId), { title: "Của A" });
    await submit(sessionActor(rc.userId), { title: "Của C" });

    // same company, different requester: hidden, and the list holds only their own
    expect((await request(app(sessionActor(rb.userId))).get("/api/portal/requests/1")).status).toBe(404);
    expect((await request(app(sessionActor(rb.userId))).get("/api/portal/requests")).body.items).toEqual([]);
    // other company has its own REQ-1; each sees only theirs
    const mine = await request(app(sessionActor(rc.userId))).get("/api/portal/requests/1");
    expect(mine.body.title).toBe("Của C");
    const mineA = await request(app(sessionActor(ra.userId))).get("/api/portal/requests/1");
    expect(mineA.body.title).toBe("Của A");

    // board routes: a requester is not a company member
    const [caseA] = await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, a.company.id));
    const board = app(sessionActor(ra.userId));
    for (const path of [`/api/pipelines/${a.pipeline.id}`, `/api/pipelines/${a.pipeline.id}/cases`, `/api/cases/${caseA.id}`, `/api/cases/${caseA.id}/events`]) {
      const status = (await request(board).get(path)).status;
      expect([403, 404], path).toContain(status);
    }
    expect((await request(board).post(`/api/cases/${caseA.id}/review`).send({ decision: "approve", expectedVersion: 1 })).status).toBeGreaterThanOrEqual(403);
  });

  it("requires a matching companyId when a user is a requester in several companies", async () => {
    const a = await seedCompany("Multi A");
    const b = await seedCompany("Multi B");
    const other = await seedCompany("Multi Other");
    const { userId } = await seedRequester(a.company.id);
    await db.insert(drRequesters).values({ companyId: b.company.id, userId });
    const actor = sessionActor(userId);

    expect((await request(app(actor)).get("/api/portal/requests")).status).toBe(400);
    expect((await request(app(actor)).get(`/api/portal/requests?companyId=${other.company.id}`)).status).toBe(403);
    expect((await request(app(actor)).get("/api/portal/requests?companyId=not-a-uuid")).status).toBe(400);
    const ok = await submit(actor, {}, `?companyId=${b.company.id}`);
    expect(ok.status).toBe(201);
    const [kase] = await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, b.company.id));
    expect(kase.caseKey).toBe(ok.body.code);
  });

  it("removes the case when the business row cannot be written (no orphan in triage)", async () => {
    const { company, pipeline, triage } = await seedCompany("Compensate Co");
    const { userId, requester } = await seedRequester(company.id);
    // number 1 is already taken by another case, so the final insert violates dr_requests_company_number_uq
    const [old] = await db
      .insert(pipelineCases)
      .values({ companyId: company.id, pipelineId: pipeline.id, stageId: triage.id, caseKey: "OLD-1", title: "Old" })
      .returning();
    await db.insert(drRequests).values({
      caseId: old.id,
      companyId: company.id,
      requestNumber: 1,
      requesterId: requester.id,
      description: "old",
    });
    await db.delete(drRequestCounters).where(eq(drRequestCounters.companyId, company.id));

    const res = await submit(sessionActor(userId));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(
      await db.select().from(pipelineCases).where(and(eq(pipelineCases.companyId, company.id), eq(pipelineCases.caseKey, "REQ-1"))),
    ).toHaveLength(0);
  });
});
