import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  drAgentOutputs,
  drEmailOutbox,
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
import { historyRoutes } from "../devflow/history/routes.js";
import { buildHistory, valueText } from "../devflow/history/build.js";

// Request history (openspec change add-request-history): the timeline of one request for staff, with nothing sensitive in it.

describe("buildHistory", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 0, n));
  it("orders newest first, sums the run costs and names the time in each stage", () => {
    const h = buildHistory({
      events: [
        { type: "ingested", at: at(0), actorName: "An", actorType: "user", fromStage: null, toStage: "Triage", payload: {} },
        { type: "transitioned", at: at(10), actorName: null, actorType: "system", fromStage: "Triage", toStage: "Triage Review", payload: {} },
        { type: "review_decided", at: at(20), actorName: "Bình", actorType: "user", fromStage: "Triage Review", toStage: "BA Spec", payload: { decision: "approve", reason: null } },
      ],
      overrides: [{ at: at(19), field: "priority", agentValue: "medium", finalValue: "high", actorName: "Bình", reason: "khách lớn", stageKey: "triage" }],
      outputs: [],
      runs: [
        { at: at(5), action: "agent.triage_run", details: { ok: true, costUsd: 0.0123, promptVersion: "v3" } },
        { at: at(6), action: "agent.ba_run", details: { ok: false, kind: "run_failed", costUsd: 0.05 } },
      ],
      emails: [],
    });
    expect(h.items.map((i) => i.kind)).toEqual(["decision", "field_change", "stage", "agent_run", "agent_run", "submitted"]);
    expect(h.costUsd).toBe(0.0623);
    expect(h.items.find((i) => i.kind === "field_change")!.summary).toBe("priority: medium → high");
    expect(h.stages.map((s) => [s.name, s.leftAt !== null])).toEqual([["Triage", true], ["Triage Review", false]]);
  });

  it("writes values as one short line and keeps only pull request numbers and links from an output", () => {
    expect(valueText(["a", "b"])).toBe("a, b");
    expect(valueText(null)).toBe("none");
    expect(valueText("x".repeat(300)).length).toBeLessThanOrEqual(120);
    const h = buildHistory({
      events: [],
      overrides: [],
      outputs: [{ at: at(1), stageKey: "dev", role: "dev", promptVersion: "v1", status: "accepted", data: { repos: [{ system: "reski", prUrl: "https://github.com/o/r/pull/7", prNumber: 7, diff: "SECRET-DIFF" }], transcript: "SECRET" } }],
      runs: [],
      emails: [],
    });
    const json = JSON.stringify(h);
    expect(json).toContain("https://github.com/o/r/pull/7");
    expect(json).not.toContain("SECRET");
  });
});

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("GET devflow/requests/:caseRef/history", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-devflow-history-");
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
    a.use("/api", historyRoutes(db));
    a.use(errorHandler);
    return a;
  };

  async function seed(label: string) {
    const [company] = await db.insert(companies).values({ name: `History ${label}`, issuePrefix: `H${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` }).returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
        { pipelineId: pipeline!.id, key: "triage_review", name: "Triage Review", kind: "review", position: 150, config: { approveToStageKey: "triage", rejectToStageKey: "triage" } },
      ])
      .returning();
    const now = new Date();
    const mk = async (name: string) => {
      const id = `user-${randomUUID()}`;
      await db.insert(authUsers).values({ id, name, email: `${id}@example.test`, createdAt: now, updatedAt: now });
      await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: id, status: "active", membershipRole: "member" });
      return id;
    };
    const staff = await mk("Bình");
    const requesterUser = await mk("An Requester");
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId: requesterUser }).returning();
    const { case: created } = await pipelineService(db).ingestCase({ companyId: company!.id, pipelineId: pipeline!.id, caseKey: `REQ-${Math.floor(Math.random() * 1e6)}`, title: "Công nợ", stageKey: "triage", actor: { type: "user", userId: requesterUser } });
    await db.insert(drRequests).values({ caseId: created.id, companyId: company!.id, requestNumber: 1, requesterId: requester!.id, description: "MÔ TẢ", priority: "high" });
    return { company: company!, stages, staff, created, requester: requester! };
  }
  const get = (ctx: Awaited<ReturnType<typeof seed>>, actor: Actor, ref: string) => request(app(actor)).get(`/api/companies/${ctx.company.id}/devflow/requests/${ref}/history`);

  it("gathers the four sources into one timeline by key or id, with nothing sensitive", async () => {
    const ctx = await seed("a");
    const c = ctx.created;
    const [ev] = await db.select().from(pipelineCaseEvents).where(eqCase(c.id));
    const [triageOut] = await db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId: c.id, stageKey: "triage", promptRole: "triage", promptVersion: "v3", promptHash: "h", data: {}, commentText: "c", status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.staff }).returning();
    await db.insert(drOverrides).values({ companyId: ctx.company.id, caseId: c.id, outputId: triageOut!.id, stageKey: "triage", field: "priority", agentValue: "medium", finalValue: "high", actorUserId: ctx.staff, reason: "khách lớn" });
    await db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId: c.id, stageKey: "dev", promptRole: "dev", promptVersion: "v1", promptHash: "h", data: { repos: [{ system: "reski", prUrl: "https://github.com/o/r/pull/9", prNumber: 9 }], secretPrompt: "KHÔNG-ĐƯỢC-LỘ" }, commentText: "c", status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.staff });
    await db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "devflow-dev", action: "agent.dev_run", entityType: "pipeline_case", entityId: c.id, details: { ok: true, costUsd: 0.36, promptVersion: "v1" } });
    await db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "devflow-dev", action: "agent.dev_failed", entityType: "pipeline_case", entityId: c.id, details: { kind: "publish_denied" } });
    await db.insert(drEmailOutbox).values({ companyId: ctx.company.id, caseId: c.id, eventId: ev!.id, requesterId: ctx.requester.id, toEmail: "an.secret@example.test", subject: "Yêu cầu đã được tiếp nhận", body: "NỘI DUNG-THƯ", status: "sent", sentAt: new Date() });

    const byKey = await get(ctx, board(ctx.staff, ctx.company.id), c.caseKey);
    expect(byKey.status).toBe(200);
    expect(byKey.body.request).toMatchObject({ caseKey: c.caseKey, requesterName: "An Requester", priority: "high" });
    const kinds = byKey.body.items.map((i: { kind: string }) => i.kind).sort();
    expect(kinds).toEqual(["agent_failed", "agent_run", "email", "field_change", "proposal", "proposal", "submitted"]);
    expect(byKey.body.costUsd).toBe(0.36);
    const text = JSON.stringify(byKey.body);
    expect(text).toContain("priority: medium → high");
    expect(text).toContain("https://github.com/o/r/pull/9");
    for (const secret of ["an.secret@example.test", "NỘI DUNG-THƯ", "KHÔNG-ĐƯỢC-LỘ"]) expect(text).not.toContain(secret);

    const byId = await get(ctx, board(ctx.staff, ctx.company.id), c.id);
    expect(byId.status).toBe(200);
    expect(byId.body.request.caseId).toBe(c.id);
  });

  it("does not show a request of another company", async () => {
    const a = await seed("x");
    const b = await seed("y");
    const res = await get(b, board(b.staff, b.company.id), a.created.caseKey);
    expect(res.status).toBe(404);
    const foreign = await request(app(board(b.staff, b.company.id))).get(`/api/companies/${a.company.id}/devflow/requests/${a.created.caseKey}/history`);
    expect([403, 404]).toContain(foreign.status);
  });
});

import { eq } from "drizzle-orm";
function eqCase(caseId: string) {
  return eq(pipelineCaseEvents.caseId, caseId);
}
void pipelineCases;
