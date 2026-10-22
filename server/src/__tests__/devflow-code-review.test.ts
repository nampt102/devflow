import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, authUsers, companies, createDb, drAgentOutputs, drRequesters, drRequests, drSystems, pipelineCaseEvents, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { APPROVED_BA_SPEC, VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";
import { grantRoles, requireRoles } from "./helpers/role-gate.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import { devRoutes } from "../devflow/dev/routes.js";
import { approveBlocker } from "../devflow/dev/review-service.js";
import { GithubError, type GithubClient } from "../devflow/dev/github.js";

// Staff review of the Dev agent's work (openspec/changes/add-dev-stage, task 4.1): queue, detail, decisions, the tech_lead
// role, closing pull requests on reject, and the round trip back to the agent.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const pr = (over: Record<string, unknown> = {}) => ({
  system: "portal",
  branch: "devflow/REQ-1",
  baseBranch: "main",
  baseSha: BASE,
  headSha: HEAD,
  commits: 1,
  filesChanged: 2,
  additions: 10,
  deletions: 1,
  prUrl: "https://github.com/acme/portal/pull/41",
  prNumber: 41,
  newPr: true,
  unprotectedWarning: false,
  ...over,
});

describe("what can be approved", () => {
  it("needs a pull request for every system and no diff DevFlow refused", () => {
    expect(approveBlocker([pr()])).toBeNull();
    expect(approveBlocker([pr(), pr({ system: "api", prNumber: 2 })])).toBeNull();
    expect(approveBlocker([])).toBe("no_pull_request");
    expect(approveBlocker([{ system: "portal", noChanges: true }])).toBe("no_pull_request");
    expect(approveBlocker([pr(), { system: "api", noChanges: true }])).toBe("no_pull_request");
    expect(approveBlocker([pr(), { system: "api", blocked: { kind: "forbidden_paths", paths: [] } }])).toBe("blocked_diff");
  });
});

describeEmbeddedPostgres("devflow Code review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-code-review-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
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

  /** A fake GitHub that records the pull requests it was asked to close. */
  function fakeGithub(opts: { fail?: boolean } = {}) {
    const closed: Array<{ repoUrl: string; number: number; token: string }> = [];
    const github = (token: string) =>
      ({
        closePr: async (repoUrl: string, number: number) => {
          if (opts.fail) throw new GithubError("github_forbidden", 403);
          closed.push({ repoUrl, number, token });
        },
      }) as unknown as GithubClient;
    return { closed, github };
  }
  const tokens = new Map<string, string>();
  const app = (actor: Actor, github = fakeGithub().github) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", devRoutes(db, { reviewCase: (input) => svc().reviewCase(input), resolveToken: async (_c, id) => tokens.get(id) ?? null, github }, {}));
    a.use(errorHandler);
    return a;
  };

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Code Review Co", issuePrefix: `R${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "dev", name: "Dev", kind: "working", position: 400 },
      {
        pipelineId: pipeline!.id,
        key: "code_review",
        name: "Code review",
        kind: "review",
        position: 450,
        config: { requireApproval: true, approver: { kind: "any_human" }, approveToStageKey: "qa", rejectToStageKey: "cancelled", requestChangesToStageKey: "dev", requireRejectReason: true, requireRequestChangesReason: true },
      },
      { pipelineId: pipeline!.id, key: "qa", name: "QA", kind: "working", position: 500 },
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
    const writeSecret = randomUUID();
    tokens.set(writeSecret, "ghp_write_secret");
    await db.insert(drSystems).values({ companyId: company!.id, key: "portal", name: "Cổng requester", repoUrl: "https://github.com/acme/portal", devEnabled: true, writeTokenSecretId: writeSecret });
    return { company: company!, pipeline: pipeline!, requesterUser, requester: requester!, reviewer, writeSecret };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  /** A request waiting in code_review with a proposal (or left in dev when `stage` says so). */
  async function seedRequest(ctx: Ctx, over: { stage?: "dev" | "code_review"; repos?: Record<string, unknown>[] } = {}) {
    const n = ++counter;
    const { case: created } = await svc().ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: `Yêu cầu ${n}`,
      stageKey: "dev",
      actor: { type: "user", userId: ctx.requesterUser },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "Mô tả chi tiết", businessImpact: null, classification: "feature", priority: "high", difficulty: "medium" });
    const approvedOutput = (stageKey: string, role: string, approved: unknown) =>
      db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId: created.id, stageKey, promptRole: role, promptVersion: "v1", promptHash: "h", status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.reviewer, data: { approved }, commentText: "x" });
    await approvedOutput("ba_spec", "ba", APPROVED_BA_SPEC);
    await approvedOutput("tech_plan", "plan", VALID_PLAN_OUTPUT);
    const [output] = await db
      .insert(drAgentOutputs)
      .values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey: "dev",
        promptRole: "dev",
        promptVersion: "v1",
        promptHash: "h",
        data: {
          summary: "Đã thêm assigneeName.",
          tasks: [
            { id: "T1", status: "done", notes: "Đã thêm trường." },
            { id: "T2", status: "partial", notes: "Mới làm một nửa." },
          ],
          checks: [
            { system: "portal", command: "npm test", passed: true, outputTail: "6 passed" },
            { system: "portal", command: "npm run lint", passed: false, outputTail: "2 errors" },
          ],
          risks: ["Chưa kiểm trên dữ liệu cũ"],
          openQuestions: [],
          confidence: "medium",
          repos: over.repos ?? [pr({ branch: `devflow/REQ-${n}` })],
          model: "claude-sonnet-5-5",
          costUsd: 1.8,
        },
        commentText: "Tóm tắt.",
      })
      .returning();
    if ((over.stage ?? "code_review") === "code_review") {
      await svc().transitionCase({ companyId: ctx.company.id, caseId: created.id, toStageKey: "code_review", expectedVersion: created.version, actor: { type: "system" } });
    }
    return { id: created.id as string, key: `REQ-${n}`, outputId: output!.id as string };
  }
  type Req = Awaited<ReturnType<typeof seedRequest>>;

  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const versionOf = async (caseId: string) => (await db.select({ v: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0]!.v;
  const outputRow = async (id: string) => (await db.select().from(drAgentOutputs).where(eq(drAgentOutputs.id, id)))[0]!;
  const activities = (companyId: string, action: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  const decide = async (ctx: Ctx, r: Req, body: Record<string, unknown>, opts: { actor?: Actor; github?: ReturnType<typeof fakeGithub>["github"] } = {}) =>
    request(app(opts.actor ?? staff(ctx.reviewer, ctx.company.id), opts.github))
      .post(`/api/companies/${ctx.company.id}/devflow/code-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), ...body });
  const get = (ctx: Ctx, suffix: string, actor?: Actor) => request(app(actor ?? staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/${suffix}`);

  // ---- reading -----------------------------------------------------------------------------------------------------
  it("lists only work waiting for code review in the company, with its pull requests and results, and counts it", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const waiting = await seedRequest(a);
    const stillCoding = await seedRequest(a, { stage: "dev" });
    const blocked = await seedRequest(a, { repos: [{ system: "portal", branch: "devflow/x", baseBranch: "main", baseSha: BASE, blocked: { kind: "forbidden_paths", paths: [".github/workflows/x.yml"] } }] });
    const theirs = await seedRequest(b);
    const res = await get(a, "code-queue");
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: any) => i.caseKey);
    expect(keys).toContain(waiting.key);
    expect(keys).toContain(blocked.key);
    expect(keys).not.toContain(stillCoding.key);
    expect(keys).not.toContain(theirs.key);
    const item = res.body.items.find((i: any) => i.caseKey === waiting.key);
    expect(item.proposal).toMatchObject({
      pullRequests: [{ system: "portal", number: 41, url: "https://github.com/acme/portal/pull/41" }],
      tasks: { total: 2, done: 1, partial: 1, skipped: 0 },
      checks: { passed: 1, failed: 1 },
      approvable: true,
      confidence: "medium",
    });
    expect(res.body.items.find((i: any) => i.caseKey === blocked.key).proposal).toMatchObject({ blocked: [{ system: "portal", kind: "forbidden_paths" }], approvable: false, pullRequests: [] });
    const count = await get(a, "code-count");
    expect(count.body.waiting).toBe(2);
    expect((await get(b, "code-count")).body.waiting).toBe(1);
  });

  it("reports Dev decisions, spending and problems from its own ledger in code-metrics", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    await db.insert(activityLog).values([
      { companyId: ctx.company.id, actorType: "system", actorId: "devflow-dev", action: "agent.dev_run", entityType: "pipeline_case", entityId: r.id, details: { ok: true, costUsd: 2.5, inputTokens: 100, outputTokens: 10 } },
      { companyId: ctx.company.id, actorType: "system", actorId: "devflow-dev", action: "agent.dev_failed", entityType: "pipeline_case", entityId: r.id, details: { kind: "run_failed", attempts: 1 } },
      { companyId: ctx.company.id, actorType: "system", actorId: "devflow-ba", action: "agent.ba_run", entityType: "pipeline_case", entityId: r.id, details: { ok: true, costUsd: 9 } },
    ]);
    await decide(ctx, r, { decision: "request_changes", reason: "Thiếu test" });
    const res = await get(ctx, "code-metrics?days=30");
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ spendUsd: 2.5, runs: 1, failed: 1 }); // BA's spending is not counted here
    expect(res.body.decisions).toMatchObject({ requestChanges: 1, approve: 0, reject: 0 });
    expect(res.body.recentFailures[0]).toMatchObject({ action: "agent.dev_failed", kind: "run_failed" });
  });

  it("shows the report next to the approved plan's tasks and the BA acceptance criteria", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await get(ctx, `code-cases/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ caseKey: r.key, outputId: r.outputId, canDecide: true, requiredRoles: [], approveBlocker: null, costUsd: 1.8, model: "claude-sonnet-5-5" });
    expect(res.body.report.checks).toHaveLength(2);
    expect(res.body.report.tasks.map((t: any) => t.id)).toEqual(["T1", "T2"]);
    expect(res.body.planTasks).toEqual(VALID_PLAN_OUTPUT.tasks.map((t) => ({ id: t.id, title: t.title, system: t.system, size: t.size })));
    expect(res.body.baSpec.acceptanceCriteria).toEqual(APPROVED_BA_SPEC.acceptanceCriteria);
    expect(res.body.repos[0]).toMatchObject({ system: "portal", name: "Cổng requester", repoUrl: "https://github.com/acme/portal", prNumber: 41 });
    expect(JSON.stringify(res.body)).not.toContain("ghp_write_secret");
  });

  it("returns 404 for a request that is not waiting for code review or belongs to another company", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const coding = await seedRequest(a, { stage: "dev" });
    const mine = await seedRequest(a);
    expect((await get(a, `code-cases/${coding.id}`)).status).toBe(404);
    expect((await get(b, `code-cases/${mine.id}`)).status).toBe(404);
    expect((await decide(b, mine, { decision: "approve" })).status).toBe(404);
    expect(await stageOf(mine.id)).toBe("code_review");
  });

  it("is for signed-in staff of the company only", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const stranger: Actor = { type: "board", source: "session", userId: "stranger", isInstanceAdmin: false, companyIds: [], memberships: [] };
    expect((await get(ctx, "code-queue", stranger)).status).toBe(404);
    expect((await get(ctx, `code-cases/${r.id}`, { type: "none", source: "none" } as Actor)).status).toBe(401);
    expect((await get(ctx, "code-queue", { type: "agent", agentId: randomUUID(), companyId: ctx.company.id, source: "agent_key" } as Actor)).status).toBe(403);
    expect((await decide(ctx, r, { decision: "approve" }, { actor: stranger })).status).toBe(404);
  });

  // ---- deciding ----------------------------------------------------------------------------------------------------
  it("approves: the request moves to QA, the pull requests are kept for it and nothing is merged or closed", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const gh = fakeGithub();
    const res = await decide(ctx, r, { decision: "approve" }, { github: gh.github });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, decision: "approve", closedPullRequests: [] });
    expect(await stageOf(r.id)).toBe("qa");
    const out = await outputRow(r.outputId);
    expect(out.status).toBe("accepted");
    expect((out.data as any).approved.repos[0]).toMatchObject({ system: "portal", prNumber: 41 });
    expect((await activities(ctx.company.id, "code.decided"))[0]!.details).toMatchObject({ decision: "approve", pullRequests: [41] });
    expect(gh.closed).toHaveLength(0);
  });

  it("will not approve work that has no pull request or that DevFlow refused to push", async () => {
    const ctx = await seedCompany();
    const none = await seedRequest(ctx, { repos: [{ system: "portal", branch: "devflow/x", baseBranch: "main", baseSha: BASE, noChanges: true }] });
    const res = await decide(ctx, none, { decision: "approve" });
    expect(res.status).toBe(422);
    expect(await stageOf(none.id)).toBe("code_review");
    expect((await outputRow(none.outputId)).status).toBe("proposed");
    expect((await get(ctx, `code-cases/${none.id}`)).body.approveBlocker).toBe("no_pull_request");
    const blocked = await seedRequest(ctx, { repos: [{ system: "portal", branch: "devflow/x", baseBranch: "main", baseSha: BASE, blocked: { kind: "diff_too_large", paths: [] } }] });
    expect((await decide(ctx, blocked, { decision: "approve" })).status).toBe(422);
    expect((await get(ctx, `code-cases/${blocked.id}`)).body.approveBlocker).toBe("blocked_diff");
    // such work can still be sent back, or rejected
    expect((await decide(ctx, blocked, { decision: "request_changes", reason: "Chia nhỏ thay đổi" })).status).toBe(200);
    expect((await decide(ctx, none, { decision: "reject", reason: "Không cần làm" })).status).toBe(200);
  });

  it("sends the work back with a reason the next run receives, keeping the pull request open", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const gh = fakeGithub();
    expect((await decide(ctx, r, { decision: "request_changes" }, { github: gh.github })).status).toBe(422); // a reason is required
    expect(await stageOf(r.id)).toBe("code_review");
    const res = await decide(ctx, r, { decision: "request_changes", reason: "Thiếu test voucher hết hạn" }, { github: gh.github });
    expect(res.status).toBe(200);
    expect(res.body.closedPullRequests).toEqual([]);
    expect(await stageOf(r.id)).toBe("dev");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    expect(gh.closed).toHaveLength(0);
    // the reason is what the Dev worker passes on (see devflow-dev.test: "gives the agent the code reviewer's reason")
    const [ev] = await db.select().from(pipelineCaseEvents).where(and(eq(pipelineCaseEvents.caseId, r.id), eq(pipelineCaseEvents.type, "review_decided")));
    expect(ev!.payload).toMatchObject({ decision: "request_changes", reason: "Thiếu test voucher hết hạn" });
  });

  it("rejects: the pull requests are closed with the system's write token, the branch stays, the request is cancelled", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, { repos: [pr({ branch: "devflow/REQ-x" })] });
    const gh = fakeGithub();
    expect((await decide(ctx, r, { decision: "reject" }, { github: gh.github })).status).toBe(422); // a reason is required
    expect(gh.closed).toHaveLength(0);
    const res = await decide(ctx, r, { decision: "reject", reason: "Hướng làm sai" }, { github: gh.github });
    expect(res.status).toBe(200);
    expect(res.body.closedPullRequests).toEqual([{ system: "portal", prNumber: 41, closed: true }]);
    expect(gh.closed).toEqual([{ repoUrl: "https://github.com/acme/portal", number: 41, token: "ghp_write_secret" }]);
    expect(await stageOf(r.id)).toBe("cancelled");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    expect((await activities(ctx.company.id, "code.pr_closed"))[0]!.details).toMatchObject({ system: "portal", prNumber: 41 });
    expect(JSON.stringify(res.body)).not.toContain("ghp_write_secret");
  });

  it("keeps a reject when GitHub cannot close the pull request, and says so for a person to do it", async () => {
    const ctx = await seedCompany();
    const failing = await seedRequest(ctx);
    const res = await decide(ctx, failing, { decision: "reject", reason: "Hướng làm sai" }, { github: fakeGithub({ fail: true }).github });
    expect(res.status).toBe(200);
    expect(res.body.closedPullRequests).toEqual([{ system: "portal", prNumber: 41, closed: false }]);
    expect(await stageOf(failing.id)).toBe("cancelled");
    expect((await activities(ctx.company.id, "code.pr_close_failed"))[0]!.details).toMatchObject({ system: "portal", prNumber: 41, kind: "github_forbidden" });
    // a system whose write token is gone
    tokens.delete(ctx.writeSecret);
    const noToken = await seedRequest(ctx);
    const res2 = await decide(ctx, noToken, { decision: "reject", reason: "Hướng làm sai" });
    expect(res2.body.closedPullRequests).toEqual([{ system: "portal", prNumber: 41, closed: false }]);
    expect((await activities(ctx.company.id, "code.pr_close_failed")).map((a) => (a.details as any).kind)).toContain("no_write_token");
    tokens.set(ctx.writeSecret, "ghp_write_secret");
  });

  it("does not let the requester review their own request", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const res = await decide(ctx, r, { decision: "approve" }, { actor: staff(ctx.requesterUser, ctx.company.id) });
    expect(res.status).toBe(403);
    expect(await stageOf(r.id)).toBe("code_review");
  });

  it("with role approvers, only Tech Lead (or an owner) may decide; BA alone may not", async () => {
    const ctx = await seedCompany();
    await requireRoles(db, ctx.pipeline.id, "code_review", ["tech_lead"]);
    const r = await seedRequest(ctx);
    const detail = async () => (await get(ctx, `code-cases/${r.id}`)).body;
    expect(await detail()).toMatchObject({ canDecide: false, requiredRoles: ["tech_lead"] });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    await grantRoles(db, ctx.company.id, ctx.reviewer, ["ba"]);
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    expect(await stageOf(r.id)).toBe("code_review");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    await grantRoles(db, ctx.company.id, ctx.reviewer, ["tech_lead"]);
    expect(await detail()).toMatchObject({ canDecide: true });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("qa");
  });

  it("refuses a decision on an outdated proposal or version, and a second decision on the same request", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const stale = await request(app(staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/code-cases/${r.id}/decision`)
      .send({ outputId: randomUUID(), expectedVersion: await versionOf(r.id), decision: "approve" });
    expect(stale.status).toBe(409);
    const wrongVersion = await request(app(staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/code-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: (await versionOf(r.id)) + 5, decision: "approve" });
    expect(wrongVersion.status).toBe(409);
    expect(await stageOf(r.id)).toBe("code_review");
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(409);
    // nothing can be edited here: unknown fields are refused
    const other = await seedRequest(ctx);
    expect((await decide(ctx, other, { decision: "approve", final: { summary: "x" } })).status).toBe(400);
  });
});
