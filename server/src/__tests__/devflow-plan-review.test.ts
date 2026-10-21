import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, drAgentOutputs, drOverrides, drRequesters, drRequests, drSystems, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { APPROVED_BA_SPEC, VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";
import { grantRoles, requireRoles } from "./helpers/role-gate.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { planAgentSpec, planWorkspaceDir } from "../devflow/plan/agent.js";
import { planService } from "../devflow/plan/plan-service.js";
import { planRoutes } from "../devflow/plan/routes.js";
import { applyTaskEdits } from "../devflow/plan/review-service.js";

// Staff review of technical plans (openspec/changes/add-tech-plan-stage, task 5.1): queue, detail, decisions,
// overrides, task edits, access, and the round trip back to the agent.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const SHA = "89abcdef0123456789abcdef0123456789abcdef";

describe("task edits", () => {
  const tasks = VALID_PLAN_OUTPUT.tasks as any[];
  const edit = (over: Record<string, unknown>[] = []) => tasks.map((t, i) => ({ id: t.id, title: t.title, description: t.description, size: t.size, ...over[i] }));

  it("keeps system, files and dependencies and takes title, description and size", () => {
    const out = applyTaskEdits(tasks, edit([{}, { size: "L", title: "Tiêu đề mới" }]))!;
    expect(out[1]).toMatchObject({ id: "T2", size: "L", title: "Tiêu đề mới", system: "portal", dependsOn: ["T1"], files: tasks[1].files });
    expect(applyTaskEdits(tasks, undefined)).toEqual(tasks);
  });

  it("refuses an edit that adds, removes or reorders tasks", () => {
    expect(applyTaskEdits(tasks, edit().slice(0, 1))).toBeNull();
    expect(applyTaskEdits(tasks, [...edit()].reverse())).toBeNull();
    expect(applyTaskEdits(tasks, [...edit(), { id: "T3", title: "x", description: "y", size: "S" }])).toBeNull();
  });
});

describeEmbeddedPostgres("devflow Plan review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-plan-review-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-plan-review-ws-"));
  }, 60_000);

  afterAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  const svc = () => pipelineService(db);
  type Actor = Express.Request["actor"];
  const staff = (userId: string, companyId: string): Actor => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "member", status: "active" }] as any,
    isInstanceAdmin: false,
  });
  const app = (actor: Actor) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", planRoutes(db, { reviewCase: (input) => svc().reviewCase(input) }, { DEVFLOW_AGENT_WORKSPACE_ROOT: root }));
    a.use(errorHandler);
    return a;
  };

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Plan Review Co", issuePrefix: `W${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "tech_plan", name: "Tech Plan", kind: "working", position: 300 },
      {
        pipelineId: pipeline!.id,
        key: "plan_review",
        name: "Plan Review",
        kind: "review",
        position: 350,
        config: { requireApproval: true, approver: { kind: "any_human" }, approveToStageKey: "dev", rejectToStageKey: "cancelled", requestChangesToStageKey: "tech_plan", requireRejectReason: true, requireRequestChangesReason: true },
      },
      { pipelineId: pipeline!.id, key: "dev", name: "Dev", kind: "working", position: 400 },
      { pipelineId: pipeline!.id, key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
    ]);
    const requesterUser = `user-${randomUUID()}`;
    const reviewer = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([
      { id: requesterUser, name: "Nguyễn Văn A", email: `${requesterUser}@example.test`, createdAt: now, updatedAt: now },
      { id: reviewer, name: "Tech Lead", email: `${reviewer}@example.test`, createdAt: now, updatedAt: now },
    ]);
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId: requesterUser }).returning();
    const spec = planAgentSpec({ workspaceRoot: root });
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: spec.name, role: "general", adapterType: spec.adapterType, adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" }, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, status: "idle" })
      .returning();
    await db.insert(drSystems).values({ companyId: company!.id, key: "portal", name: "Cổng requester", repoUrl: "https://github.com/acme/portal" });
    return { company: company!, pipeline: pipeline!, requesterUser, requester: requester!, reviewer, agentId: agent!.id };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  /** A request waiting in plan_review with a proposed plan (or left in tech_plan when `stage` says so). */
  async function seedRequest(ctx: Ctx, over: { stage?: "tech_plan" | "plan_review" } = {}) {
    const n = ++counter;
    const { case: created } = await svc().ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: `Yêu cầu ${n}`,
      stageKey: "tech_plan",
      actor: { type: "user", userId: ctx.requesterUser },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "Mô tả chi tiết", businessImpact: null, classification: "feature", priority: "high", difficulty: "medium" });
    await db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId: created.id, stageKey: "ba_spec", promptRole: "ba", promptVersion: "v1", promptHash: "h", status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.reviewer, data: { approved: APPROVED_BA_SPEC }, commentText: "x" });
    const [output] = await db
      .insert(drAgentOutputs)
      .values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey: "tech_plan",
        agentId: ctx.agentId,
        promptRole: "plan",
        promptVersion: "v1",
        promptHash: "h",
        data: { ...VALID_PLAN_OUTPUT, repos: [{ system: "portal", sha: SHA }], model: "claude-sonnet-5-5", costUsd: 0.42 },
        commentText: "Tóm tắt.",
      })
      .returning();
    if ((over.stage ?? "plan_review") === "plan_review") {
      await svc().transitionCase({ companyId: ctx.company.id, caseId: created.id, toStageKey: "plan_review", expectedVersion: created.version, actor: { type: "system" } });
    }
    return { id: created.id as string, key: `REQ-${n}`, outputId: output!.id as string };
  }
  type Req = Awaited<ReturnType<typeof seedRequest>>;

  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const versionOf = async (caseId: string) => (await db.select({ v: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0]!.v;
  const outputRow = async (id: string) => (await db.select().from(drAgentOutputs).where(eq(drAgentOutputs.id, id)))[0]!;
  const overridesOf = (caseId: string) => db.select().from(drOverrides).where(eq(drOverrides.caseId, caseId));
  const decide = async (ctx: Ctx, r: Req, body: Record<string, unknown>, actor?: Actor) =>
    request(app(actor ?? staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/plan-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), ...body });
  const get = (ctx: Ctx, suffix: string, actor?: Actor) => request(app(actor ?? staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/${suffix}`);
  const taskEdits = (over: Record<string, unknown>[] = []) => VALID_PLAN_OUTPUT.tasks.map((t, i) => ({ id: t.id, title: t.title, description: t.description, size: t.size, ...over[i] }));

  // ---- reading -----------------------------------------------------------------------------------------------------
  it("lists only plans waiting for review in the company, with task sizes, and counts them", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const waiting = await seedRequest(a);
    const stillPlanning = await seedRequest(a, { stage: "tech_plan" });
    const theirs = await seedRequest(b);
    const res = await get(a, "plan-queue");
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: any) => i.caseKey);
    expect(keys).toContain(waiting.key);
    expect(keys).not.toContain(stillPlanning.key);
    expect(keys).not.toContain(theirs.key);
    const item = res.body.items.find((i: any) => i.caseKey === waiting.key);
    expect(item.proposal).toMatchObject({ confidence: "medium", systems: ["portal"], tasks: 2, sizes: { S: 1, M: 1, L: 0 }, openQuestions: 1 });
    expect(JSON.stringify(res.body)).not.toContain("@example.test");
    expect((await get(a, "plan-count")).body).toMatchObject({ waiting: 1 });
  });

  it("shows the plan with repository links and the approved spec it was made from", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await get(ctx, `plan-cases/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body.plan.tasks).toHaveLength(2);
    expect(res.body.plan.approach).toBe(VALID_PLAN_OUTPUT.approach);
    expect(res.body.repos).toEqual([{ system: "portal", sha: SHA, name: "Cổng requester", repoUrl: "https://github.com/acme/portal" }]);
    expect(res.body.baSpec.acceptanceCriteria).toEqual(APPROVED_BA_SPEC.acceptanceCriteria);
    expect(res.body).toMatchObject({ model: "claude-sonnet-5-5", costUsd: 0.42, outputId: r.outputId });
  });

  it("keeps companies apart: another company's staff cannot read or decide", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const r = await seedRequest(a);
    const outsider = staff(b.reviewer, b.company.id);
    // no access to the company reads as "not found", so its existence is not revealed
    expect((await get(a, `plan-cases/${r.id}`, outsider)).status).toBe(404);
    expect((await decide(a, r, { decision: "approve" }, outsider)).status).toBe(404);
    // their own company path with our case id finds nothing
    expect((await get(b, `plan-cases/${r.id}`)).status).toBe(404);
    expect(await stageOf(r.id)).toBe("plan_review");
  });

  // ---- deciding ----------------------------------------------------------------------------------------------------
  it("approves as proposed: accepted, no overrides, the plan kept in data.approved, the request goes to Dev", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(await stageOf(r.id)).toBe("dev");
    const out = await outputRow(r.outputId);
    expect(out.status).toBe("accepted");
    expect((out.data as any).approved.tasks).toEqual(VALID_PLAN_OUTPUT.tasks);
    expect(await overridesOf(r.id)).toHaveLength(0);
    const [log] = await db.select().from(activityLog).where(eq(activityLog.action, "plan.decided"));
    expect(log!.details).toMatchObject({ decision: "approve", overriddenFields: [] });
  });

  it("records each corrected field, including a task size, and keeps the reviewer's version", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve", final: { testPlan: ["Test thủ công trên portal"], tasks: taskEdits([{}, { size: "L" }]) } });
    expect(res.status).toBe(200);
    expect(res.body.overriddenFields.sort()).toEqual(["tasks", "testPlan"]);
    const out = await outputRow(r.outputId);
    expect(out.status).toBe("overridden");
    const approved = (out.data as any).approved;
    expect(approved.tasks[1]).toMatchObject({ id: "T2", size: "L", dependsOn: ["T1"], files: VALID_PLAN_OUTPUT.tasks[1]!.files });
    expect(approved.testPlan).toEqual(["Test thủ công trên portal"]);
    expect(out.commentText).toContain("cỡ L");
    const rows = await overridesOf(r.id);
    const tasksRow = rows.find((o) => o.field === "tasks")!;
    expect((tasksRow.agentValue as any)[1].size).toBe("M");
    expect((tasksRow.finalValue as any)[1].size).toBe("L");
  });

  it("refuses to change the task list itself (422) and changes nothing", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "approve", final: { tasks: taskEdits().slice(0, 1) } })).status).toBe(422);
    // fields beyond title, description and size are not accepted at all
    expect((await decide(ctx, r, { decision: "approve", final: { tasks: taskEdits([{ system: "billing" }]) } })).status).toBe(400);
    expect(await stageOf(r.id)).toBe("plan_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
  });

  it("does not let requesters review their own request, nor decide on a replaced proposal", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "approve" }, staff(ctx.requesterUser, ctx.company.id))).status).toBe(403);
    expect((await decide(ctx, { ...r, outputId: randomUUID() }, { decision: "approve" })).status).toBe(409);
    expect((await decide(ctx, r, { decision: "reject" })).status).toBe(422); // a reason is required
    expect((await decide(ctx, r, { decision: "reject", reason: "Không làm" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("cancelled");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(409);
  });

  it("with role approvers, only Tech Lead (or an owner) may approve the plan; BA alone may not", async () => {
    const ctx = await seedCompany();
    await requireRoles(db, ctx.pipeline.id, "plan_review", ["tech_lead"]);
    const r = await seedRequest(ctx);
    const detail = async () => (await get(ctx, `plan-cases/${r.id}`)).body;
    expect(await detail()).toMatchObject({ canDecide: false, requiredRoles: ["tech_lead"] });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);

    await grantRoles(db, ctx.company.id, ctx.reviewer, ["ba"]);
    expect(await detail()).toMatchObject({ canDecide: false });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    expect(await stageOf(r.id)).toBe("plan_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    expect(await overridesOf(r.id)).toHaveLength(0);

    await grantRoles(db, ctx.company.id, ctx.reviewer, ["tech_lead"]);
    expect(await detail()).toMatchObject({ canDecide: true });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("dev");
  });

  it("sends the plan back with a reason the next run receives", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "request_changes", reason: "Thiếu bước migration dữ liệu cũ" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("tech_plan");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    const seen: string[] = [];
    const service = planService(db, {
      pipelines: svc(),
      runner: {
        async run() {
          seen.push(fs.readFileSync(path.join(planWorkspaceDir(root), ".devflow", "request.md"), "utf8"));
          return { runId: null, ok: true, text: JSON.stringify({ ...VALID_PLAN_OUTPUT, tasks: VALID_PLAN_OUTPUT.tasks.map((t) => ({ ...t, system: null, files: [] })) }), subtype: "success", errorCode: null, costUsd: 0.3, inputTokens: 1, outputTokens: 1, model: null };
        },
      },
      clone: (async () => ({ sha: SHA })) as any,
      resolveToken: async () => null,
      workspaceRoot: root,
      claudeHome: path.join(root, "home"),
    });
    expect(await service.runCase(ctx.company.id, r.id)).toBe("proposed");
    expect(seen[0]).toContain("Thiếu bước migration dữ liệu cũ");
    expect(await stageOf(r.id)).toBe("plan_review");
  });

  // ---- setup and numbers -------------------------------------------------------------------------------------------
  it("publishes the Planner's expected setup and says whether the company's agent matches", async () => {
    const ctx = await seedCompany();
    const res = await get(ctx, "plan-agent");
    expect(res.status).toBe(200);
    expect(res.body.spec).toMatchObject({ name: "DevFlow Planner", adapterType: "claude_local" });
    expect(res.body.agent).toMatchObject({ id: ctx.agentId, problem: null });
  });

  it("reports quality and cost from the Tech Plan ledger only", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    await decide(ctx, r, { decision: "approve", final: { risks: ["Lộ tên nhân viên"] } });
    const log = (action: string, costUsd: number) =>
      db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "x", action, entityType: "pipeline_case", entityId: r.id, details: { ok: true, costUsd } });
    await log("agent.plan_run", 0.5);
    await log("agent.ba_run", 9);
    const res = await get(ctx, "plan-metrics?days=7");
    expect(res.status).toBe(200);
    expect(res.body.approved).toMatchObject({ total: 1, overridden: 1, overrideRate: 1 });
    expect(res.body.fields).toEqual([{ field: "risks", overrides: 1, rate: 1 }]);
    expect(res.body.decisions.approve).toBe(1);
    expect(res.body.agent).toMatchObject({ runs: 1, spendUsd: 0.5 });
  });
});
