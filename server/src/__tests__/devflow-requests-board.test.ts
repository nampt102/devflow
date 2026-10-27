import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, authUsers, companies, companyMemberships, createDb, drRequesters, drRequestSystems, drRequests, drSystems, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { boardRoutes } from "../devflow/board/routes.js";

// Requests board (openspec change add-request-board): every request by stage, who is waited on, agent problems that still
// stand, who may decide where, and a company never sees another's.

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("GET devflow/requests-board", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-devflow-board-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];
  const board = (userId: string, companyId: string): Actor => ({ type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: "member", status: "active" }] as any, isInstanceAdmin: false });
  const app = (actor: Actor) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", boardRoutes(db));
    a.use(errorHandler);
    return a;
  };

  async function seed(label: string) {
    const [company] = await db.insert(companies).values({ name: `Board ${label}`, issuePrefix: `B${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` }).returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
        { pipelineId: pipeline!.id, key: "triage_review", name: "Triage Review", kind: "review", position: 150, config: { approver: { kind: "role", roles: ["ba"] } } },
        { pipelineId: pipeline!.id, key: "ba_review", name: "BA Review", kind: "review", position: 250 },
        { pipelineId: pipeline!.id, key: "done", name: "Done", kind: "done", position: 900 },
      ])
      .returning();
    const now = new Date();
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId }).returning();
    const [system] = await db.insert(drSystems).values({ companyId: company!.id, key: "reski", name: "RESKI", repoUrl: "https://github.com/o/r", defaultBranch: "main", docsPath: "docs", description: "" } as any).returning();
    const stageId = (k: string) => stages.find((s) => s.key === k)!.id;
    let n = 0;
    async function makeCase(key: string, stage: string, opts: { terminal?: "done" } = {}) {
      const { case: c } = await pipelineService(db).ingestCase({ companyId: company!.id, pipelineId: pipeline!.id, caseKey: key, title: `Yêu cầu ${key}`, stageKey: "triage", actor: { type: "user", userId } });
      await db.update(pipelineCases).set({ stageId: stageId(stage), ...(opts.terminal ? { terminalKind: opts.terminal } : {}) }).where(eq(pipelineCases.id, c.id));
      await db.insert(drRequests).values({ caseId: c.id, companyId: company!.id, requestNumber: ++n, requesterId: requester!.id, description: "d", priority: "high", classification: "feature" });
      return c;
    }
    return { company: company!, userId, system: system!, makeCase };
  }
  const get = (ctx: Awaited<ReturnType<typeof seed>>, actor: Actor, q = "") => request(app(actor)).get(`/api/companies/${ctx.company.id}/devflow/requests-board${q}`);

  it("lists columns in pipeline order and each request in its stage, saying who is waited on", async () => {
    const ctx = await seed("a");
    const working = await ctx.makeCase("REQ-1", "triage");
    const review = await ctx.makeCase("REQ-2", "ba_review");
    await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: review.id, systemId: ctx.system.id });
    await ctx.makeCase("REQ-3", "done", { terminal: "done" });
    const res = await get(ctx, board(ctx.userId, ctx.company.id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.columns.map((c: { key: string }) => c.key)).toEqual(["triage", "triage_review", "ba_review", "done"]);
    const card = (key: string) => res.body.cards.find((c: { caseKey: string }) => c.caseKey === key);
    expect(card("REQ-1")).toMatchObject({ stageKey: "triage", waitingFor: "agent", reviewPage: null, canDecide: false });
    expect(card("REQ-2")).toMatchObject({ stageKey: "ba_review", waitingFor: "person", reviewPage: "ba-review", systems: ["reski"], canDecide: true });
    expect(card("REQ-3")).toMatchObject({ waitingFor: null, terminal: "done", reviewPage: null });
    void working;
  });

  it("says a member without the role cannot decide where the stage asks for it", async () => {
    const ctx = await seed("b");
    await ctx.makeCase("REQ-1", "triage_review");
    const res = await get(ctx, board(ctx.userId, ctx.company.id));
    expect(res.body.cards[0]).toMatchObject({ stageKey: "triage_review", waitingFor: "person", canDecide: false });
  });

  it("shows an agent problem only until a run succeeds after it", async () => {
    const ctx = await seed("c");
    const c = await ctx.makeCase("REQ-1", "triage");
    const log = (action: string, details: Record<string, unknown>, at: number) =>
      db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "devflow", action, entityType: "pipeline_case", entityId: c.id, details, createdAt: new Date(Date.now() - at * 60_000) });
    await log("agent.ba_failed", { kind: "run_failed" }, 10);
    let res = await get(ctx, board(ctx.userId, ctx.company.id));
    expect(res.body.cards[0].lastFailure).toMatchObject({ action: "agent.ba_failed", kind: "run_failed" });
    await log("agent.ba_run", { ok: true, costUsd: 0.1 }, 5);
    res = await get(ctx, board(ctx.userId, ctx.company.id));
    expect(res.body.cards[0].lastFailure).toBeNull();
  });

  it("keeps finished requests to the limit, and never shows another company's", async () => {
    const a = await seed("d");
    for (let i = 1; i <= 3; i++) await a.makeCase(`REQ-${i}`, "done", { terminal: "done" });
    const limited = await get(a, board(a.userId, a.company.id), "?doneLimit=2");
    expect(limited.body.cards).toHaveLength(2);
    const b = await seed("e");
    const own = await get(b, board(b.userId, b.company.id));
    expect(own.body.cards).toEqual([]);
    const foreign = await request(app(board(b.userId, b.company.id))).get(`/api/companies/${a.company.id}/devflow/requests-board`);
    expect([403, 404]).toContain(foreign.status);
  });
});
