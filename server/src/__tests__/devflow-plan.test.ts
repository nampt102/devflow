import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  createDb,
  drAgentOutputs,
  drRequestSystems,
  drRequesters,
  drRequests,
  drSystems,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { PROMPT_HASH } from "../devflow/prompts/plan.v1.js";
import type { StageRunResult, StageRunner } from "../devflow/agent-stage/runner.js";
import { claudeTranscriptsDir } from "../devflow/agent-stage/agent.js";
import { createStageWorker } from "../devflow/agent-stage/worker.js";
import { baAgentSpec, baWorkspaceDir } from "../devflow/ba/agent.js";
import { baService } from "../devflow/ba/ba-service.js";
import { createBaWorker } from "../devflow/ba/worker.js";
import { planAgentSpec, planWorkspaceDir } from "../devflow/plan/agent.js";
import { planService } from "../devflow/plan/plan-service.js";
import { VALID_BA_OUTPUT } from "./helpers/ba-fixtures.js";
import { APPROVED_BA_SPEC, VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";

// Tech Plan for one request (openspec/changes/add-tech-plan-stage, tasks 4.1 and 4.2): the whole flow with a fake
// runner and a fake clone, against a real database, and how it shares the instance with BA.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type RunStep = Partial<StageRunResult> & { text?: string | null; during?: () => Promise<void> };
const noFiles = (o: typeof VALID_PLAN_OUTPUT) => JSON.stringify({ ...o, tasks: o.tasks.map((t) => ({ ...t, system: null, files: [] })) });

describeEmbeddedPostgres("devflow Tech Plan", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  const home = () => path.join(root, "home");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-plan-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-plan-ws-"));
  }, 60_000);

  afterAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  // ---- fakes -------------------------------------------------------------------------------------------------------
  function fakeRunner(workspace: () => string, steps: RunStep[], fallback: string) {
    const calls: Array<{ agentId: string; caseId: string; request: string; repos: string[] }> = [];
    const runner: StageRunner = {
      async run(input) {
        const request = fs.readFileSync(path.join(workspace(), ".devflow", "request.md"), "utf8");
        const repos = fs.readdirSync(path.join(workspace(), "repos"));
        calls.push({ agentId: input.agentId, caseId: input.caseId, request, repos });
        const step = steps.shift() ?? { text: fallback };
        await step.during?.();
        const { during: _during, ...rest } = step;
        return { runId: null, ok: true, text: fallback, subtype: "success", errorCode: null, costUsd: 0.4, inputTokens: 5000, outputTokens: 900, model: "claude-sonnet-5-5", ...rest };
      },
    };
    return { runner, calls };
  }
  const clone = async (input: { dest: string }) => {
    fs.mkdirSync(path.join(input.dest, "docs"), { recursive: true });
    return { sha: "89abcdef0123456789abcdef0123456789abcdef" };
  };
  const deps = (runner: StageRunner, maxUsdPerDay?: number) => ({
    pipelines: pipelineService(db),
    runner,
    clone: clone as any,
    resolveToken: async () => null,
    workspaceRoot: root,
    claudeHome: home(),
    maxUsdPerDay,
  });
  const makePlan = (steps: RunStep[] = [], opts: { maxUsdPerDay?: number } = {}) => {
    const r = fakeRunner(() => planWorkspaceDir(root), steps, JSON.stringify(VALID_PLAN_OUTPUT));
    return { service: planService(db, deps(r.runner, opts.maxUsdPerDay)), runs: r.calls };
  };
  const makeBa = (steps: RunStep[] = [], opts: { maxUsdPerDay?: number } = {}) => {
    const r = fakeRunner(() => baWorkspaceDir(root), steps, JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] }));
    return { service: baService(db, deps(r.runner, opts.maxUsdPerDay)), runs: r.calls };
  };

  // ---- seeding -----------------------------------------------------------------------------------------------------
  async function seedCompany(opts: { planAgent?: boolean; baAgent?: boolean } = {}) {
    const [company] = await db
      .insert(companies)
      .values({ name: "Plan Co", issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      { pipelineId: pipeline!.id, key: "ba_spec", name: "BA Spec", kind: "working", position: 200 },
      { pipelineId: pipeline!.id, key: "ba_review", name: "BA Review", kind: "review", position: 250, config: { approveToStageKey: "tech_plan", rejectToStageKey: "ba_spec" } },
      { pipelineId: pipeline!.id, key: "tech_plan", name: "Tech Plan", kind: "working", position: 300 },
      { pipelineId: pipeline!.id, key: "plan_review", name: "Plan Review", kind: "review", position: 350, config: { approveToStageKey: "tech_plan", rejectToStageKey: "tech_plan" } },
    ]);
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId }).returning();
    const addAgent = async (spec: ReturnType<typeof planAgentSpec>) =>
      (
        await db
          .insert(agents)
          .values({ companyId: company!.id, name: spec.name, role: "general", adapterType: spec.adapterType, adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" }, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, status: "idle" })
          .returning()
      )[0]!.id;
    const planAgentId = opts.planAgent === false ? null : await addAgent(planAgentSpec({ workspaceRoot: root }));
    const baAgentId = opts.baAgent ? await addAgent(baAgentSpec({ workspaceRoot: root })) : null;
    return { company: company!, pipeline: pipeline!, userId, requester: requester!, planAgentId, baAgentId };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  async function seedRequest(ctx: Ctx, over: { stage?: string; approved?: Record<string, unknown> | null } = {}) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: "Cho requester thấy người xử lý",
      stageKey: over.stage ?? "tech_plan",
      actor: { type: "user", userId: ctx.userId },
    });
    await db.insert(drRequests).values({
      caseId: created.id,
      companyId: ctx.company.id,
      requestNumber: n,
      requesterId: ctx.requester.id,
      description: "Người yêu cầu muốn thấy ai đang xử lý yêu cầu của mình.",
      businessImpact: "Giảm email hỏi lại",
      classification: "feature",
      priority: "high",
      difficulty: "medium",
    });
    if (over.approved !== null) {
      // the agent's draft said something else; the reviewer's version is in data.approved
      await db.insert(drAgentOutputs).values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey: "ba_spec",
        promptRole: "ba",
        promptVersion: "v1",
        promptHash: "h",
        status: "overridden",
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        data: { ...VALID_BA_OUTPUT, acceptanceCriteria: ["BẢN NHÁP CỦA AGENT"], approved: over.approved ?? APPROVED_BA_SPEC },
        commentText: "x",
      });
    }
    return created.id as string;
  }
  async function seedSystem(ctx: Ctx, key = "portal") {
    const [system] = await db.insert(drSystems).values({ companyId: ctx.company.id, key, name: key, repoUrl: `https://github.com/acme/${key}` }).returning();
    return system!;
  }
  const assign = (ctx: Ctx, caseId: string, systemId: string) => db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId, systemId });
  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const planOutputsOf = (caseId: string) => db.select().from(drAgentOutputs).where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "tech_plan")));
  const activities = (companyId: string, action: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  async function wipe() {
    await db.delete(activityLog);
    await db.delete(pipelineCases);
  }

  // ---- service -----------------------------------------------------------------------------------------------------
  it("plans from the approved spec and the assigned repositories, stores the proposal and sends the request to Plan review", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const system = await seedSystem(ctx);
    await assign(ctx, caseId, system.id);
    const transcripts = claudeTranscriptsDir(planWorkspaceDir(root), home());
    const t = makePlan([{ during: async () => fs.mkdirSync(path.join(transcripts, "run"), { recursive: true }) }]);

    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");

    expect(await stageOf(caseId)).toBe("plan_review");
    const [out] = await planOutputsOf(caseId);
    expect(out).toMatchObject({ status: "proposed", promptRole: "plan", promptVersion: "v1", promptHash: PROMPT_HASH, agentId: ctx.planAgentId });
    expect((out!.data as any).tasks).toHaveLength(2);
    expect((out!.data as any).repos).toEqual([{ system: "portal", sha: "89abcdef0123456789abcdef0123456789abcdef" }]);
    expect(out!.commentText).toContain("**Kế hoạch test**");

    const request = t.runs[0]!.request;
    expect(t.runs[0]!.agentId).toBe(ctx.planAgentId);
    expect(t.runs[0]!.repos).toEqual(["portal"]);
    expect(request).toContain("Trang yêu cầu hiện tên người xử lý (đã sửa bởi người duyệt)"); // the reviewer's version
    expect(request).not.toContain("BẢN NHÁP CỦA AGENT");
    expect(request).toContain("commit 89abcdef0123");
    // nothing of the request is left on disk, transcripts included
    expect(fs.existsSync(planWorkspaceDir(root))).toBe(false);
    expect(fs.existsSync(transcripts)).toBe(false);
    // its own ledger, not BA's
    const [run] = await activities(ctx.company.id, "agent.plan_run");
    expect(run!.details).toMatchObject({ ok: true, costUsd: 0.4, promptVersion: "v1" });
    expect(run!.actorId).toBe("devflow-plan");
    expect(await activities(ctx.company.id, "agent.ba_run")).toHaveLength(0);
    expect(await activities(ctx.company.id, "agent.plan_proposed")).toHaveLength(1);
  });

  it("does not run without an approved BA spec", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx, { approved: null });
    const t = makePlan();
    await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "no_approved_spec" });
    expect(t.runs).toHaveLength(0);
    // a superseded (sent back) spec does not count either
    await db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId, stageKey: "ba_spec", promptRole: "ba", promptVersion: "v1", promptHash: "h", status: "superseded", decidedAt: new Date(), decidedByUserId: ctx.userId, data: { approved: APPROVED_BA_SPEC }, commentText: "x" });
    await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "no_approved_spec" });
  });

  it("plans without a system when none is assigned: tasks name no system and no file", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const t = makePlan([{ text: noFiles(VALID_PLAN_OUTPUT) }]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.runs[0]!.request).toContain("(none assigned)");
    // citing a repository nobody assigned is refused, also on the retry
    const second = await seedRequest(ctx);
    const t2 = makePlan();
    await expect(t2.service.runCase(ctx.company.id, second)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(t2.runs).toHaveLength(2);
  });

  it("asks once more with the reason when the plan has a dependency cycle, then gives up", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const system = await seedSystem(ctx);
    await assign(ctx, caseId, system.id);
    const cyclic = JSON.stringify({ ...VALID_PLAN_OUTPUT, tasks: VALID_PLAN_OUTPUT.tasks.map((x) => ({ ...x, dependsOn: [x.id === "T1" ? "T2" : "T1"] })) });
    const t = makePlan([{ text: cyclic }, { text: cyclic }]);
    await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(t.runs[1]!.request).toContain("Write the plan again");
    expect(t.runs[1]!.request).toContain("task dependencies form a cycle");
    expect(await planOutputsOf(caseId)).toHaveLength(0);
    expect(await stageOf(caseId)).toBe("tech_plan");
  });

  it("writes nothing when the request moved while the agent was working", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const t = makePlan([
      {
        text: noFiles(VALID_PLAN_OUTPUT),
        during: async () => {
          const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
          await pipelineService(db).transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "ba_spec", expectedVersion: c!.version, actor: { type: "user", userId: ctx.userId } });
        },
      },
    ]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("stale");
    expect(await planOutputsOf(caseId)).toHaveLength(0);
  });

  it("gives the agent the plan reviewer's reason after request_changes", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    // a BA-era request_changes is older than any plan: never passed on
    await db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId, type: "review_decided", actorType: "user", actorId: ctx.userId, payload: { decision: "request_changes", reason: "lý do của BA review" }, createdAt: new Date(Date.now() - 3_600_000) });
    const first = makePlan([{ text: noFiles(VALID_PLAN_OUTPUT) }]);
    await first.service.runCase(ctx.company.id, caseId);
    expect(first.runs[0]!.request).not.toContain("REVIEWER FEEDBACK");
    await db.update(drAgentOutputs).set({ status: "superseded" }).where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "tech_plan")));
    await db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId, type: "review_decided", actorType: "user", actorId: ctx.userId, payload: { decision: "request_changes", reason: "thiếu bước migration dữ liệu cũ" }, createdAt: new Date(Date.now() + 1000) });
    const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
    await pipelineService(db).transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "tech_plan", expectedVersion: c!.version, actor: { type: "user", userId: ctx.userId } });
    const second = makePlan([{ text: noFiles(VALID_PLAN_OUTPUT) }]);
    expect(await second.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(second.runs[0]!.request).toContain("thiếu bước migration dữ liệu cũ");
    expect(second.runs[0]!.request).not.toContain("lý do của BA review");
  });

  it("uses each company's own Planner and refuses a company without one", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const none = await seedCompany({ planAgent: false, baAgent: true }); // a BA agent is not a Planner
    const caseA = await seedRequest(a);
    const caseB = await seedRequest(b);
    const caseNone = await seedRequest(none);
    const t = makePlan([{ text: noFiles(VALID_PLAN_OUTPUT) }, { text: noFiles(VALID_PLAN_OUTPUT) }]);
    await t.service.runCase(a.company.id, caseA);
    await t.service.runCase(b.company.id, caseB);
    expect(t.runs.map((r) => r.agentId)).toEqual([a.planAgentId, b.planAgentId]);
    await expect(t.service.runCase(none.company.id, caseNone)).rejects.toMatchObject({ kind: "no_agent" });
    // another company's case id is not found under this company
    expect(await t.service.runCase(a.company.id, caseB)).toBe("stale");
  });

  // ---- sharing the instance with BA --------------------------------------------------------------------------------
  describe("with the BA stage", () => {
    beforeEach(wipe);
    const opts = { baseBackoffMs: 1000, maxBackoffMs: 10_000, configRetryMs: 5000, breakerThreshold: 99 };

    it("never runs while a BA run holds the lock, and runs on the next pass", async () => {
      const ctx = await seedCompany({ baAgent: true });
      const baCase = await seedRequest(ctx, { stage: "ba_spec", approved: null });
      const planCase = await seedRequest(ctx);
      const plan = makePlan([{ text: noFiles(VALID_PLAN_OUTPUT) }]);
      const planWorker = createStageWorker(db, plan.service, "plan", opts);
      let attemptedDuringBa = -1;
      const ba = makeBa([{ during: async () => void (attemptedDuringBa = await planWorker.sweep()) }]);
      await createBaWorker(db, ba.service, opts).sweep();
      expect(await stageOf(baCase)).toBe("ba_review");
      expect(attemptedDuringBa).toBe(0);
      expect(plan.runs).toHaveLength(0);
      expect(await planWorker.sweep()).toBe(1);
      expect(await stageOf(planCase)).toBe("plan_review");
    });

    it("keeps the daily caps apart: BA spending does not pause the Planner, Planner spending does not pause BA", async () => {
      const ctx = await seedCompany({ baAgent: true });
      const caseId = await seedRequest(ctx);
      const log = (action: string, costUsd: number) =>
        db.insert(activityLog).values({ companyId: ctx.company.id, actorType: "system", actorId: "x", action, entityType: "pipeline_case", entityId: caseId, details: { costUsd } });
      await log("agent.ba_run", 50);
      const plan = makePlan([], { maxUsdPerDay: 5 });
      expect(await plan.service.overBudgetCompanies()).toEqual([]);
      await log("agent.plan_run", 6);
      expect((await plan.service.overBudgetCompanies()).map((o) => o.companyId)).toEqual([ctx.company.id]);
      const ba = makeBa([], { maxUsdPerDay: 55 }).service;
      expect(await ba.overBudgetCompanies()).toEqual([]); // 50 of BA's 55, the Planner's 6 not counted
    });

    it("retries a missing approved spec calmly, never giving up, and notes it once", async () => {
      const ctx = await seedCompany();
      const caseId = await seedRequest(ctx, { approved: null });
      const clock = { t: Date.now() };
      const w = createStageWorker(db, makePlan().service, "plan", { ...opts, now: () => clock.t });
      for (let i = 0; i < 6; i++) {
        await w.sweep();
        clock.t += 6000;
      }
      expect(await activities(ctx.company.id, "agent.plan_failed")).toHaveLength(1);
      expect((await activities(ctx.company.id, "agent.plan_failed"))[0]!.details).toMatchObject({ kind: "no_approved_spec" });
      expect(await activities(ctx.company.id, "agent.plan_gave_up")).toHaveLength(0);
      expect(await stageOf(caseId)).toBe("tech_plan");
    });
  });
});
