import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
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
  drRequestSystems,
  drRequesters,
  drRequests,
  drSystems,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { VALID_BA_OUTPUT } from "./helpers/ba-fixtures.js";
import { grantRoles, requireRoles } from "./helpers/role-gate.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { baAgentSpec } from "../devflow/ba/agent.js";
import { baService } from "../devflow/ba/ba-service.js";
import { baRoutes } from "../devflow/ba/routes.js";

// Staff review of BA specs (openspec/changes/add-ba-spec-stage, tasks 5.1): queue, detail, decisions, overrides,
// systems, atomicity, access, and the round trip back to the agent.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow BA review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-ba-review-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-ba-review-ws-"));
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
    a.use("/api", baRoutes(db, { reviewCase: (input) => svc().reviewCase(input) }, { DEVFLOW_AGENT_WORKSPACE_ROOT: root }));
    a.use(errorHandler);
    return a;
  };

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "BA Review Co", issuePrefix: `V${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "ba_spec", name: "BA Spec", kind: "working", position: 200 },
      {
        pipelineId: pipeline!.id,
        key: "ba_review",
        name: "BA Review",
        kind: "review",
        position: 250,
        config: { requireApproval: true, approver: { kind: "any_human" }, approveToStageKey: "tech_plan", rejectToStageKey: "cancelled", requestChangesToStageKey: "ba_spec", requireRejectReason: true, requireRequestChangesReason: true },
      },
      { pipelineId: pipeline!.id, key: "tech_plan", name: "Tech Plan", kind: "working", position: 300 },
      { pipelineId: pipeline!.id, key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
    ]);
    const requesterUser = `user-${randomUUID()}`;
    const reviewer = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([
      { id: requesterUser, name: "Nguyễn Văn A", email: `${requesterUser}@example.test`, createdAt: now, updatedAt: now },
      { id: reviewer, name: "Reviewer", email: `${reviewer}@example.test`, createdAt: now, updatedAt: now },
    ]);
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId: requesterUser }).returning();
    const spec = baAgentSpec({ workspaceRoot: root });
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: spec.name, role: "general", adapterType: spec.adapterType, adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" }, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, status: "idle" })
      .returning();
    return { company: company!, pipeline: pipeline!, requesterUser, requester: requester!, reviewer, agentId: agent!.id };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  const system = async (ctx: Ctx, key: string, over: Record<string, unknown> = {}) =>
    (await db.insert(drSystems).values({ companyId: ctx.company.id, key, name: key.toUpperCase(), description: `${key} system`, repoUrl: `https://github.com/acme/${key}`, ...over }).returning())[0]!;

  let counter = 0;
  /** A request waiting in ba_review with a proposed spec (or left in ba_spec when `stage` says so). */
  async function seedRequest(ctx: Ctx, over: { data?: Record<string, unknown>; stage?: "ba_spec" | "ba_review"; title?: string } = {}) {
    const n = ++counter;
    const { case: created } = await svc().ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: over.title ?? `Yêu cầu ${n}`,
      stageKey: "ba_spec",
      actor: { type: "user", userId: ctx.requesterUser },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "Mô tả chi tiết", businessImpact: "Ảnh hưởng 5 người", classification: "feature", priority: "high", difficulty: "medium" });
    const [output] = await db
      .insert(drAgentOutputs)
      .values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey: "ba_spec",
        agentId: ctx.agentId,
        promptRole: "ba",
        promptVersion: "v1",
        promptHash: "h",
        data: { ...VALID_BA_OUTPUT, repos: [{ system: "portal", sha: "0123456789abcdef0123456789abcdef01234567" }], model: "claude-haiku-5-5", costUsd: 0.31, ...over.data },
        commentText: "Tóm tắt.",
      })
      .returning();
    if ((over.stage ?? "ba_review") === "ba_review") {
      await svc().transitionCase({ companyId: ctx.company.id, caseId: created.id, toStageKey: "ba_review", expectedVersion: created.version, actor: { type: "system" } });
    }
    return { id: created.id as string, key: `REQ-${n}`, outputId: output!.id as string };
  }
  type Req = Awaited<ReturnType<typeof seedRequest>>;

  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const versionOf = async (caseId: string) => (await db.select({ v: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0]!.v;
  const outputRow = async (id: string) => (await db.select().from(drAgentOutputs).where(eq(drAgentOutputs.id, id)))[0]!;
  const overridesOf = (caseId: string) => db.select().from(drOverrides).where(eq(drOverrides.caseId, caseId));
  const assignedKeys = async (caseId: string) =>
    (await db.select({ key: drSystems.key }).from(drRequestSystems).innerJoin(drSystems, eq(drSystems.id, drRequestSystems.systemId)).where(eq(drRequestSystems.caseId, caseId))).map((r) => r.key).sort();
  const decide = async (ctx: Ctx, r: Req, body: Record<string, unknown>, actor?: Actor) =>
    request(app(actor ?? staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/ba-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), ...body });
  const get = (ctx: Ctx, suffix: string, actor?: Actor) => request(app(actor ?? staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/${suffix}`);

  // ---- reading -----------------------------------------------------------------------------------------------------
  it("lists only specs waiting for review in the company, without account identifiers, and counts them", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const waiting = await seedRequest(a);
    const stillWriting = await seedRequest(a, { stage: "ba_spec" });
    const theirs = await seedRequest(b);
    const res = await get(a, "ba-queue");
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: any) => i.caseKey);
    expect(keys).toContain(waiting.key);
    expect(keys).not.toContain(stillWriting.key);
    expect(keys).not.toContain(theirs.key);
    const item = res.body.items.find((i: any) => i.caseKey === waiting.key);
    expect(item).toMatchObject({ requesterName: "Nguyễn Văn A", outputId: waiting.outputId, promptVersion: "v1" });
    expect(item.proposal).toMatchObject({ summary: VALID_BA_OUTPUT.summary, confidence: "medium", systems: ["portal"], openQuestions: 1, acceptanceCriteria: 1 });
    expect(Number.isNaN(new Date(item.proposedAt).getTime())).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("@example.test");
    expect(JSON.stringify(res.body)).not.toContain(a.requesterUser);
    const count = await get(a, "ba-count");
    expect(count.body.waiting).toBe(1);
    expect(Number.isNaN(new Date(count.body.newest).getTime())).toBe(false);
    expect((await get(b, "ba-count")).body.waiting).toBe(1);
    const empty = await seedCompany();
    expect((await get(empty, "ba-count")).body).toEqual({ waiting: 0, newest: null });
  });

  it("shows the whole spec, the commit read, a link to each repository and the systems that can be chosen", async () => {
    const ctx = await seedCompany();
    const portal = await system(ctx, "portal");
    await system(ctx, "erp");
    await system(ctx, "old", { active: false, tokenSecretId: randomUUID() });
    const r = await seedRequest(ctx);
    await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: r.id, systemId: portal.id });
    const res = await get(ctx, `ba-cases/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ caseKey: r.key, description: "Mô tả chi tiết", outputId: r.outputId, version: await versionOf(r.id), model: "claude-haiku-5-5", costUsd: 0.31 });
    expect(res.body.triage).toEqual({ classification: "feature", priority: "high", difficulty: "medium" });
    expect(res.body.spec.acceptanceCriteria).toEqual(VALID_BA_OUTPUT.acceptanceCriteria);
    expect(res.body.spec.affectedAreas[0]).toMatchObject({ system: "portal", path: "server/src/devflow/portal/portal-service.ts", line: 17 });
    expect(res.body.repos).toEqual([{ system: "portal", sha: "0123456789abcdef0123456789abcdef01234567", name: "PORTAL", repoUrl: "https://github.com/acme/portal" }]);
    expect(res.body.systems.available.map((x: any) => x.key)).toEqual(["ERP".toLowerCase(), "portal"]);
    expect(res.body.systems.selectedIds).toEqual([portal.id]);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenSecret|token_secret/);
    expect((await get(ctx, `ba-cases/${(await seedRequest(ctx, { stage: "ba_spec" })).id}`)).status).toBe(404); // not in review
  });

  // ---- deciding ----------------------------------------------------------------------------------------------------
  it("approve without changes: accepted, no overrides, the approved spec is kept with the proposal, the case moves on", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: "approve", overriddenFields: [] });
    expect(await stageOf(r.id)).toBe("tech_plan");
    const out = await outputRow(r.outputId);
    expect(out).toMatchObject({ status: "accepted", decidedByUserId: ctx.reviewer });
    expect(out.decidedAt).toBeTruthy();
    expect((out.data as any).approved).toMatchObject({ summary: VALID_BA_OUTPUT.summary, acceptanceCriteria: VALID_BA_OUTPUT.acceptanceCriteria, confidence: "medium" });
    expect((out.data as any).approved.affectedAreas).toEqual(VALID_BA_OUTPUT.affectedAreas);
    expect((out.data as any).repos).toHaveLength(1); // the proposal itself is untouched
    expect(await overridesOf(r.id)).toHaveLength(0);
    const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, r.id), eq(activityLog.action, "ba.decided")));
    expect(logged!.details).toMatchObject({ decision: "approve", overriddenFields: [], systemsChanged: false });
  });

  it("approve with edits records one override per changed field and keeps the final text", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const final = {
      acceptanceCriteria: ["Trang chi tiết hiện tên người xử lý", "Tên không hiện cho yêu cầu đã hủy"],
      risks: [],
      summary: VALID_BA_OUTPUT.summary, // sent unchanged: not an override
    };
    const res = await decide(ctx, r, { decision: "approve", final });
    expect(res.status).toBe(200);
    expect(res.body.overriddenFields.sort()).toEqual(["acceptanceCriteria", "risks"]);
    const overrides = await overridesOf(r.id);
    expect(overrides.map((o) => o.field).sort()).toEqual(["acceptanceCriteria", "risks"]);
    expect(overrides.find((o) => o.field === "risks")).toMatchObject({ stageKey: "ba_spec", agentValue: VALID_BA_OUTPUT.risks, finalValue: [], actorUserId: ctx.reviewer });
    const out = await outputRow(r.outputId);
    expect(out.status).toBe("overridden");
    expect((out.data as any).approved.acceptanceCriteria).toEqual(final.acceptanceCriteria);
    expect((out.data as any).acceptanceCriteria).toEqual(VALID_BA_OUTPUT.acceptanceCriteria); // what the agent wrote stays on record
    expect(out.commentText).toContain("Tên không hiện cho yêu cầu đã hủy");
    expect((out.data as any).approved.affectedAreas).toEqual(VALID_BA_OUTPUT.affectedAreas); // citations are not editable
  });

  it("refuses edits that break the spec's rules and writes nothing", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const bad: Array<[string, Record<string, unknown>, number]> = [
      ["unknown field (citations are the agent's)", { affectedAreas: [] }, 400],
      ["a field that is not editable", { confidence: "high" }, 400],
      ["a too long text", { summary: "x".repeat(801) }, 400],
      ["too many items", { risks: Array(11).fill("r") }, 400],
      ["wrong type", { inScope: "text" }, 400],
      ["no acceptance criterion", { acceptanceCriteria: [] }, 400],
      ["nothing in scope", { inScope: [] }, 400],
    ];
    for (const [name, final, status] of bad) {
      expect((await decide(ctx, r, { decision: "approve", final })).status, name).toBe(status);
    }
    expect(await stageOf(r.id)).toBe("ba_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    expect(await overridesOf(r.id)).toHaveLength(0);
  });

  it("request changes needs a reason, sends the case back, supersedes the spec and lets the next run use new systems", async () => {
    const ctx = await seedCompany();
    const portal = await system(ctx, "portal");
    const erp = await system(ctx, "erp");
    const r = await seedRequest(ctx);
    await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: r.id, systemId: portal.id });
    expect((await decide(ctx, r, { decision: "request_changes" })).status).toBeGreaterThanOrEqual(400);
    expect(await stageOf(r.id)).toBe("ba_review");
    expect(await assignedKeys(r.id)).toEqual(["portal"]);

    const res = await decide(ctx, r, { decision: "request_changes", reason: "Thiếu phần ERP, hãy đọc cả ERP", systemIds: [portal.id, erp.id] });
    expect(res.status).toBe(200);
    expect(await stageOf(r.id)).toBe("ba_spec");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    expect(await overridesOf(r.id)).toHaveLength(0);
    expect(await assignedKeys(r.id)).toEqual(["erp", "portal"]);

    // the BA service picks it up again: both repositories, and the reviewer's reason as data
    const seen: Array<{ repos: string[]; request: string }> = [];
    const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [{ ...VALID_BA_OUTPUT.affectedAreas[0], system: "erp" }] });
    const service = baService(db, {
      pipelines: svc(),
      runner: {
        async run() {
          const dir = path.join(root, "ba");
          seen.push({ repos: fs.readdirSync(path.join(dir, "repos")).sort(), request: fs.readFileSync(path.join(dir, ".devflow", "request.md"), "utf8") });
          return { runId: null, ok: true, text: noAreas, subtype: "success", errorCode: null, costUsd: 0.1, inputTokens: 1, outputTokens: 1, model: "m" };
        },
      },
      clone: (async (input: { dest: string }) => {
        fs.mkdirSync(input.dest, { recursive: true });
        return { sha: "f".repeat(40) };
      }) as any,
      resolveToken: async () => null,
      workspaceRoot: root,
    });
    expect(await service.baCase(ctx.company.id, r.id)).toBe("proposed");
    expect(seen[0]!.repos).toEqual(["erp", "portal"]);
    expect(seen[0]!.request).toContain("Thiếu phần ERP, hãy đọc cả ERP");
    expect(await stageOf(r.id)).toBe("ba_review");
  });

  it("request changes without a systems list leaves the assignment alone, and reject ignores it", async () => {
    const ctx = await seedCompany();
    const portal = await system(ctx, "portal");
    const a = await seedRequest(ctx);
    await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: a.id, systemId: portal.id });
    expect((await decide(ctx, a, { decision: "request_changes", reason: "chi tiết hơn" })).status).toBe(200);
    expect(await assignedKeys(a.id)).toEqual(["portal"]);
    const b = await seedRequest(ctx);
    await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: b.id, systemId: portal.id });
    const res = await decide(ctx, b, { decision: "reject", reason: "Không làm", systemIds: [] });
    expect(res.status).toBe(200);
    expect(await stageOf(b.id)).toBe("cancelled");
    expect(await assignedKeys(b.id)).toEqual(["portal"]);
    expect((await outputRow(b.outputId)).status).toBe("superseded");
  });

  it("refuses a system of another company or one that is switched off, and writes nothing", async () => {
    const ctx = await seedCompany();
    const other = await seedCompany();
    const theirs = await system(other, "theirs");
    const off = await system(ctx, "off", { active: false });
    const r = await seedRequest(ctx);
    for (const id of [theirs.id, off.id, randomUUID()]) {
      expect((await decide(ctx, r, { decision: "request_changes", reason: "x", systemIds: [id] })).status, id).toBe(422);
      expect((await decide(ctx, r, { decision: "approve", systemIds: [id] })).status, id).toBe(422);
    }
    expect(await stageOf(r.id)).toBe("ba_review");
    expect(await assignedKeys(r.id)).toEqual([]);
    expect((await outputRow(r.outputId)).status).toBe("proposed");
  });

  it("approve can also change the systems, which later stages then read", async () => {
    const ctx = await seedCompany();
    const erp = await system(ctx, "erp");
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "approve", systemIds: [erp.id] })).status).toBe(200);
    expect(await assignedKeys(r.id)).toEqual(["erp"]);
  });

  it("a stale version or proposal gives 409 and nothing is written", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const wrongVersion = await request(app(staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/ba-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: (await versionOf(r.id)) + 5, decision: "approve" });
    expect(wrongVersion.status).toBeGreaterThanOrEqual(400);
    const wrongOutput = await decide(ctx, r, { decision: "approve", outputId: randomUUID() });
    expect(wrongOutput.status).toBe(409);
    expect(await stageOf(r.id)).toBe("ba_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    // already decided: a second decision is a conflict
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(409);
  });

  it("if saving the domain records fails, the decision rolls back with them (case stays in review)", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    // an override row for the same output and field already exists, so the hook's insert fails mid-way
    await db.insert(drOverrides).values({ companyId: ctx.company.id, caseId: r.id, outputId: r.outputId, stageKey: "ba_spec", field: "summary", agentValue: "a", finalValue: "b", actorUserId: ctx.reviewer });
    const res = await decide(ctx, r, { decision: "approve", final: { summary: "Tóm tắt đã sửa" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stageOf(r.id)).toBe("ba_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    expect((await outputRow(r.outputId)).data).not.toHaveProperty("approved");
  });

  it("a decision that loses the race after our checks is a 409: the case moved, or the proposal was settled meanwhile", async () => {
    const ctx = await seedCompany();
    const racingApp = (before: (caseId: string) => Promise<void>) => {
      const racing = express();
      racing.use(express.json());
      racing.use((req, _res, next) => {
        req.actor = staff(ctx.reviewer, ctx.company.id);
        next();
      });
      racing.use("/api", baRoutes(db, { reviewCase: async (input) => { await before(input.caseId); return svc().reviewCase(input); } }, { DEVFLOW_AGENT_WORKSPACE_ROOT: root }));
      racing.use(errorHandler);
      return racing;
    };
    const post = async (a: express.Express, r: Req) =>
      request(a).post(`/api/companies/${ctx.company.id}/devflow/ba-cases/${r.id}/decision`).send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), decision: "approve" });

    // someone else's decision moves the case right after our checks
    const moved = await seedRequest(ctx);
    const [tech] = await db.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, ctx.pipeline.id), eq(pipelineStages.key, "tech_plan")));
    expect((await post(racingApp(async (id) => { await db.update(pipelineCases).set({ stageId: tech!.id }).where(eq(pipelineCases.id, id)); }), moved)).status).toBe(409);

    // the proposal is settled by someone else while the case still looks reviewable
    const settled = await seedRequest(ctx);
    const res = await post(racingApp(async () => { await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.id, settled.outputId)); }), settled);
    expect(res.status).toBe(409);
    expect(await stageOf(settled.id)).toBe("ba_review");
    expect(await overridesOf(settled.id)).toHaveLength(0);
  });

  it("edits sent with a request for changes are not kept: the agent writes the spec again", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "request_changes", reason: "Làm lại phần phạm vi", final: { summary: "Tóm tắt do người duyệt viết" } });
    expect(res.status).toBe(200);
    expect(res.body.overriddenFields).toEqual([]);
    expect(await overridesOf(r.id)).toHaveLength(0);
    const out = await outputRow(r.outputId);
    expect(out.status).toBe("superseded");
    expect((out.data as any).summary).toBe(VALID_BA_OUTPUT.summary);
    expect(out.data).not.toHaveProperty("approved");
  });

  it("two reviewers deciding at once: one wins, the other gets a 409", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const version = await versionOf(r.id);
    const go = () => request(app(staff(ctx.reviewer, ctx.company.id))).post(`/api/companies/${ctx.company.id}/devflow/ba-cases/${r.id}/decision`).send({ outputId: r.outputId, expectedVersion: version, decision: "approve" });
    const results = await Promise.all([go(), go()]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await stageOf(r.id)).toBe("tech_plan");
    expect((await overridesOf(r.id)).length).toBe(0);
  });

  it("a requester cannot review their own request", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve" }, staff(ctx.requesterUser, ctx.company.id));
    expect(res.status).toBe(403);
    expect(await stageOf(r.id)).toBe("ba_review");
  });

  it("with role approvers, BA or Tech Lead may decide (either one), and the screen says so", async () => {
    const ctx = await seedCompany();
    await requireRoles(db, ctx.pipeline.id, "ba_review", ["ba", "tech_lead"]);
    const r = await seedRequest(ctx);
    const detail = async () => (await get(ctx, `ba-cases/${r.id}`)).body;
    expect(await detail()).toMatchObject({ canDecide: false, requiredRoles: ["ba", "tech_lead"] });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    expect(await stageOf(r.id)).toBe("ba_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    expect(await overridesOf(r.id)).toHaveLength(0);

    await grantRoles(db, ctx.company.id, ctx.reviewer, ["tech_lead"]);
    expect(await detail()).toMatchObject({ canDecide: true });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("tech_plan");
  });

  it("is for signed-in staff of the company only: agents and signed-out callers are refused, other companies see nothing", async () => {
    const ctx = await seedCompany();
    const other = await seedCompany();
    const r = await seedRequest(ctx);
    const agent = { type: "agent", agentId: randomUUID(), companyId: ctx.company.id, source: "agent_key" } as Actor;
    for (const suffix of ["ba-queue", "ba-count", `ba-cases/${r.id}`, "ba-agent"]) {
      expect((await get(ctx, suffix, { type: "none", source: "none" } as Actor)).status, suffix).toBe(401);
      expect((await get(ctx, suffix, agent)).status, suffix).toBe(403);
      expect((await get(ctx, suffix, staff(other.reviewer, other.company.id))).status, suffix).toBe(404);
    }
    expect((await decide(ctx, r, { decision: "approve" }, agent)).status).toBe(403);
    expect((await decide(ctx, r, { decision: "approve" }, staff(other.reviewer, other.company.id))).status).toBe(404);
    expect(await stageOf(r.id)).toBe("ba_review");
    // a staff member of another company cannot read this company's case through their own company path either
    const cross = await request(app(staff(other.reviewer, other.company.id))).get(`/api/companies/${other.company.id}/devflow/ba-cases/${r.id}`);
    expect(cross.status).toBe(404);
  });

  it("tells staff whether this company's BA agent is set up and as safe as specified", async () => {
    const ctx = await seedCompany();
    const res = await get(ctx, "ba-agent");
    expect(res.status).toBe(200);
    expect(res.body.spec).toMatchObject({ name: "DevFlow BA", adapterType: "claude_local", promptVersion: "v1" });
    expect(res.body.agent).toMatchObject({ id: ctx.agentId, status: "idle", problem: null });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, ctx.agentId));
    expect((await get(ctx, "ba-agent")).body.agent.problem).toBe("agent_not_runnable");
    const none = await seedCompany();
    await db.delete(agents).where(eq(agents.id, none.agentId));
    expect((await get(none, "ba-agent")).body.agent).toBeNull();
  });
});
