import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, drAgentOutputs, drRequestSystems, drRequesters, drRequests, drSystems, environments, pipelineCaseEvents, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { APPROVED_BA_SPEC, VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";
import { grantRoles, requireRoles } from "./helpers/role-gate.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService } from "../services/pipelines.js";
import type { StageRunResult, StageRunner } from "../devflow/agent-stage/runner.js";
import { DEV_RUNNER_ENVIRONMENT, devAgentSpec, devWorkspaceDir } from "../devflow/dev/agent.js";
import { devService } from "../devflow/dev/dev-service.js";
import { GithubError, type GithubClient } from "../devflow/dev/github.js";
import { REPOS_DIR } from "../devflow/dev/workspace.js";
import { qaRoutes } from "../devflow/qa/routes.js";

// QA sign-off (openspec/changes/add-qa-stage, tasks 4.1 and 4.2): queue, detail, decisions, the qa role, closing pull requests on
// reject, the round trip back to the Dev agent with what QA found, and the agreement of the signer with the recommendation.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const SHA = "89abcdef0123456789abcdef0123456789abcdef";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

type Verdict = "pass" | "fail" | "not_verified";
const qaData = (rec: "approve" | "changes", verdicts: Record<string, Verdict> = {}, over: Record<string, unknown> = {}) => ({
  summary: "Hai tiêu chí đã kiểm.",
  criteria: ["AC1", "AC2"].map((id) => ({ id, verdict: verdicts[id] ?? "pass", how: "automated", evidence: `${id}: đã chạy test.` })),
  checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "6 passed" }],
  issues: [],
  manualTests: ["Mở màn hình voucher."],
  confidence: "medium",
  repos: [{ system: "portal", branch: "devflow/REQ-1", approvedSha: SHA, testedSha: SHA, prUrl: "https://github.com/acme/portal/pull/41", prNumber: 41, warnings: [] }],
  warnings: [],
  recommendation: { value: rec, reasons: rec === "approve" ? [] : ["criteria_failed:AC2"] },
  criteriaText: { AC1: "Trang yêu cầu hiện tên người xử lý", AC2: "Khách không thấy mã nội bộ" },
  model: "claude-sonnet-5-5",
  costUsd: 0.8,
  ...over,
});

describeEmbeddedPostgres("devflow QA sign-off", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  let runnerEnvId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-qa-review-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-qa-review-ws-"));
    const [env] = await db
      .insert(environments)
      .values({ name: DEV_RUNNER_ENVIRONMENT, driver: "ssh", config: { remoteWorkspacePath: root, knownHosts: "devflow-runner ssh-ed25519 AAAA", strictHostKeyChecking: true } })
      .returning();
    runnerEnvId = env!.id;
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
    a.use("/api", qaRoutes(db, { reviewCase: (input) => svc().reviewCase(input), resolveToken: async (_c, id) => tokens.get(id) ?? null, github }, {}));
    a.use(errorHandler);
    return a;
  };

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "QA Review Co", issuePrefix: `V${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      { pipelineId: pipeline!.id, key: "code_review", name: "Code review", kind: "review", position: 450, config: { approveToStageKey: "qa", rejectToStageKey: "cancelled", requestChangesToStageKey: "dev" } },
      { pipelineId: pipeline!.id, key: "dev", name: "Dev", kind: "working", position: 400 },
      { pipelineId: pipeline!.id, key: "qa", name: "QA", kind: "working", position: 500 },
      {
        pipelineId: pipeline!.id,
        key: "qa_signoff",
        name: "QA sign-off",
        kind: "review",
        position: 550,
        config: { requireApproval: true, approver: { kind: "any_human" }, approveToStageKey: "done", rejectToStageKey: "cancelled", requestChangesToStageKey: "dev", requireRejectReason: true, requireRequestChangesReason: true },
      },
      { pipelineId: pipeline!.id, key: "done", name: "Done", kind: "done", position: 900 },
      { pipelineId: pipeline!.id, key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
    ]);
    const requesterUser = `user-${randomUUID()}`;
    const reviewer = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([
      { id: requesterUser, name: "Nguyễn Văn A", email: `${requesterUser}@example.test`, createdAt: now, updatedAt: now },
      { id: reviewer, name: "QA", email: `${reviewer}@example.test`, createdAt: now, updatedAt: now },
    ]);
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId: requesterUser }).returning();
    const writeSecret = randomUUID();
    tokens.set(writeSecret, "ghp_write_secret");
    const [system] = await db.insert(drSystems).values({ companyId: company!.id, key: "portal", name: "Cổng requester", repoUrl: "https://github.com/acme/portal", devEnabled: true, writeTokenSecretId: writeSecret, testCommand: "npm test" }).returning();
    return { company: company!, pipeline: pipeline!, requesterUser, requester: requester!, reviewer, writeSecret, system: system! };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  /** A request waiting in qa_signoff with a QA report; its Dev work was approved (accepted) earlier. */
  async function seedRequest(ctx: Ctx, over: { stage?: "qa" | "qa_signoff"; data?: Record<string, unknown> } = {}) {
    const n = ++counter;
    const { case: created } = await svc().ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: `Yêu cầu ${n}`,
      stageKey: "qa",
      actor: { type: "user", userId: ctx.requesterUser },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "Mô tả chi tiết", businessImpact: null, classification: "feature", priority: "high", difficulty: "medium" });
    await db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId: created.id, systemId: ctx.system.id });
    const approvedOutput = (stageKey: string, role: string, approved: unknown) =>
      db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId: created.id, stageKey, promptRole: role, promptVersion: "v1", promptHash: "h", status: "accepted", decidedAt: new Date(Date.now() - 60_000), decidedByUserId: ctx.reviewer, data: { approved }, commentText: "x" });
    await approvedOutput("ba_spec", "ba", APPROVED_BA_SPEC);
    await approvedOutput("tech_plan", "plan", VALID_PLAN_OUTPUT);
    await approvedOutput("dev", "dev", { summary: "Đã làm.", tasks: [{ id: "T1", status: "done", notes: "ok" }], checks: [], repos: [{ system: "portal", branch: `devflow/REQ-${n}`, prUrl: "https://github.com/acme/portal/pull/41", prNumber: 41, headSha: SHA }] });
    const [output] = await db
      .insert(drAgentOutputs)
      .values({ companyId: ctx.company.id, caseId: created.id, stageKey: "qa", promptRole: "qa", promptVersion: "v1", promptHash: "h", data: over.data ?? qaData("approve"), commentText: "Báo cáo." })
      .returning();
    if ((over.stage ?? "qa_signoff") === "qa_signoff") {
      await svc().transitionCase({ companyId: ctx.company.id, caseId: created.id, toStageKey: "qa_signoff", expectedVersion: created.version, actor: { type: "system" } });
    }
    return { id: created.id as string, key: `REQ-${n}`, outputId: output!.id as string };
  }
  type Req = Awaited<ReturnType<typeof seedRequest>>;

  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const versionOf = async (caseId: string) => (await db.select({ v: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0]!.v;
  const outputRow = async (id: string) => (await db.select().from(drAgentOutputs).where(eq(drAgentOutputs.id, id)))[0]!;
  const devOutputs = (caseId: string) => db.select().from(drAgentOutputs).where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "dev")));
  const activities = (companyId: string, action: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  const decide = async (ctx: Ctx, r: Req, body: Record<string, unknown>, opts: { actor?: Actor; github?: ReturnType<typeof fakeGithub>["github"] } = {}) =>
    request(app(opts.actor ?? staff(ctx.reviewer, ctx.company.id), opts.github))
      .post(`/api/companies/${ctx.company.id}/devflow/qa-cases/${r.id}/decision`)
      .send({ outputId: r.outputId, expectedVersion: await versionOf(r.id), ...body });
  const get = (ctx: Ctx, suffix: string, actor?: Actor) => request(app(actor ?? staff(ctx.reviewer, ctx.company.id))).get(`/api/companies/${ctx.company.id}/devflow/${suffix}`);

  // ---- reading -----------------------------------------------------------------------------------------------------
  it("lists only reports waiting for sign-off in the company, with verdict counts and the recommendation, and counts them", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const waiting = await seedRequest(a, { data: qaData("changes", { AC2: "fail" }, { issues: [{ severity: "high", title: "Lộ mã", steps: "Mở app khách" }] }) });
    const stillTesting = await seedRequest(a, { stage: "qa" });
    const theirs = await seedRequest(b);
    const res = await get(a, "qa-queue");
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: any) => i.caseKey);
    expect(keys).toContain(waiting.key);
    expect(keys).not.toContain(stillTesting.key);
    expect(keys).not.toContain(theirs.key);
    const item = res.body.items.find((i: any) => i.caseKey === waiting.key);
    expect(item.proposal).toMatchObject({
      recommendation: "changes",
      criteria: { total: 2, pass: 1, fail: 1, notVerified: 0 },
      checks: { passed: 1, failed: 0 },
      issues: { high: 1, total: 1 },
      pullRequests: [{ system: "portal", number: 41, url: "https://github.com/acme/portal/pull/41" }],
    });
    expect((await get(a, "qa-count")).body.waiting).toBe(1);
    expect((await get(b, "qa-count")).body.waiting).toBe(1);
  });

  it("shows each criterion with its text and evidence, the commands, issues, manual steps, recommendation and warnings", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, { data: qaData("changes", { AC2: "not_verified" }, { warnings: ["branch_moved"] }) });
    const res = await get(ctx, `qa-cases/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ caseKey: r.key, outputId: r.outputId, canDecide: true, requiredRoles: [], costUsd: 0.8, model: "claude-sonnet-5-5", warnings: ["branch_moved"] });
    expect(res.body.recommendation).toEqual({ value: "changes", reasons: ["criteria_failed:AC2"] });
    expect(res.body.report.criteria).toEqual([
      expect.objectContaining({ id: "AC1", verdict: "pass", text: "Trang yêu cầu hiện tên người xử lý", evidence: "AC1: đã chạy test." }),
      expect.objectContaining({ id: "AC2", verdict: "not_verified", text: "Khách không thấy mã nội bộ" }),
    ]);
    expect(res.body.report.manualTests).toEqual(["Mở màn hình voucher."]);
    expect(res.body.repos[0]).toMatchObject({ system: "portal", name: "Cổng requester", repoUrl: "https://github.com/acme/portal", testedSha: SHA, prNumber: 41 });
    expect(JSON.stringify(res.body)).not.toContain("ghp_write_secret");
  });

  it("returns 404 for a request that is not waiting for sign-off or belongs to another company, and is for staff only", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const testing = await seedRequest(a, { stage: "qa" });
    const mine = await seedRequest(a);
    expect((await get(a, `qa-cases/${testing.id}`)).status).toBe(404);
    expect((await get(b, `qa-cases/${mine.id}`)).status).toBe(404);
    expect((await decide(b, mine, { decision: "approve" })).status).toBe(404);
    const stranger: Actor = { type: "board", source: "session", userId: "stranger", isInstanceAdmin: false, companyIds: [], memberships: [] };
    expect((await get(a, "qa-queue", stranger)).status).toBe(404);
    expect((await get(a, `qa-cases/${mine.id}`, { type: "none", source: "none" } as Actor)).status).toBe(401);
    expect((await get(a, "qa-queue", { type: "agent", agentId: randomUUID(), companyId: a.company.id, source: "agent_key" } as Actor)).status).toBe(403);
    expect(await stageOf(mine.id)).toBe("qa_signoff");
  });

  // ---- deciding ----------------------------------------------------------------------------------------------------
  it("approves: the request is done, the report is kept, and nothing is merged or closed, even against the recommendation", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, { data: qaData("changes", { AC2: "fail" }) });
    const gh = fakeGithub();
    const res = await decide(ctx, r, { decision: "approve" }, { github: gh.github });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, decision: "approve", closedPullRequests: [] });
    expect(await stageOf(r.id)).toBe("done");
    const out = await outputRow(r.outputId);
    expect(out.status).toBe("accepted");
    expect((out.data as any).approved).toMatchObject({ summary: "Hai tiêu chí đã kiểm.", recommendation: { value: "changes" } });
    expect((await activities(ctx.company.id, "qa.decided"))[0]!.details).toMatchObject({ decision: "approve", recommendation: "changes", pullRequests: [41] });
    expect(gh.closed).toHaveLength(0);
  });

  it("sends the work back to Dev with a reason: the QA report and the Dev work are both superseded, the pull request stays open", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx, { data: qaData("changes", { AC2: "fail" }) });
    const gh = fakeGithub();
    expect((await decide(ctx, r, { decision: "request_changes" }, { github: gh.github })).status).toBe(422); // a reason is required
    expect(await stageOf(r.id)).toBe("qa_signoff");
    const res = await decide(ctx, r, { decision: "request_changes", reason: "AC2 sai khi voucher hết hạn" }, { github: gh.github });
    expect(res.status).toBe(200);
    expect(res.body.closedPullRequests).toEqual([]);
    expect(await stageOf(r.id)).toBe("dev");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    expect((await devOutputs(r.id)).map((o) => o.status)).toEqual(["superseded"]); // so the Dev worker finds the feedback
    expect(gh.closed).toHaveLength(0);
  });

  it("rejects: the pull requests are closed with the system's write token, the branch stays, the request is cancelled", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    const gh = fakeGithub();
    expect((await decide(ctx, r, { decision: "reject" }, { github: gh.github })).status).toBe(422);
    expect(gh.closed).toHaveLength(0);
    const res = await decide(ctx, r, { decision: "reject", reason: "Không cần nữa" }, { github: gh.github });
    expect(res.status).toBe(200);
    expect(res.body.closedPullRequests).toEqual([{ system: "portal", prNumber: 41, closed: true }]);
    expect(gh.closed).toEqual([{ repoUrl: "https://github.com/acme/portal", number: 41, token: "ghp_write_secret" }]);
    expect(await stageOf(r.id)).toBe("cancelled");
    expect((await outputRow(r.outputId)).status).toBe("superseded");
    expect((await devOutputs(r.id)).map((o) => o.status)).toEqual(["accepted"]); // the code that was approved stays recorded
    expect(JSON.stringify(res.body)).not.toContain("ghp_write_secret");
    // when GitHub refuses, the decision stands and a person is told to close it
    const other = await seedRequest(ctx);
    const failed = await decide(ctx, other, { decision: "reject", reason: "Không cần nữa" }, { github: fakeGithub({ fail: true }).github });
    expect(failed.body.closedPullRequests).toEqual([{ system: "portal", prNumber: 41, closed: false }]);
    expect(await stageOf(other.id)).toBe("cancelled");
    expect((await activities(ctx.company.id, "code.pr_close_failed"))[0]!.details).toMatchObject({ kind: "github_forbidden" });
  });

  it("does not let the requester sign off their own request, and refuses an outdated proposal or a second decision", async () => {
    const ctx = await seedCompany();
    const r = await seedRequest(ctx);
    expect((await decide(ctx, r, { decision: "approve" }, { actor: staff(ctx.requesterUser, ctx.company.id) })).status).toBe(403);
    const stale = await request(app(staff(ctx.reviewer, ctx.company.id)))
      .post(`/api/companies/${ctx.company.id}/devflow/qa-cases/${r.id}/decision`)
      .send({ outputId: randomUUID(), expectedVersion: await versionOf(r.id), decision: "approve" });
    expect(stale.status).toBe(409);
    expect(await stageOf(r.id)).toBe("qa_signoff");
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(409);
    const other = await seedRequest(ctx);
    expect((await decide(ctx, other, { decision: "approve", final: { summary: "x" } })).status).toBe(400); // nothing is edited here
  });

  it("with role approvers, only QA or Tech Lead (or an owner) may sign off; BA alone may not", async () => {
    const ctx = await seedCompany();
    await requireRoles(db, ctx.pipeline.id, "qa_signoff", ["qa", "tech_lead"]);
    const r = await seedRequest(ctx);
    const detail = async () => (await get(ctx, `qa-cases/${r.id}`)).body;
    expect(await detail()).toMatchObject({ canDecide: false, requiredRoles: ["qa", "tech_lead"] });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    await grantRoles(db, ctx.company.id, ctx.reviewer, ["ba"]);
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(403);
    expect(await stageOf(r.id)).toBe("qa_signoff");
    expect((await outputRow(r.outputId)).status).toBe("proposed");
    await grantRoles(db, ctx.company.id, ctx.reviewer, ["qa"]);
    expect(await detail()).toMatchObject({ canDecide: true });
    expect((await decide(ctx, r, { decision: "approve" })).status).toBe(200);
    expect(await stageOf(r.id)).toBe("done");
  });

  it("measures how often the signer goes against the recommendation, and reports the QA spending apart from Dev's", async () => {
    const ctx = await seedCompany();
    const agree = await seedRequest(ctx, { data: qaData("approve") });
    const approvedAgainst = await seedRequest(ctx, { data: qaData("changes", { AC2: "fail" }) });
    const returnedAgainst = await seedRequest(ctx, { data: qaData("approve") });
    const agreeBack = await seedRequest(ctx, { data: qaData("changes", { AC2: "fail" }) });
    await db.insert(activityLog).values([
      { companyId: ctx.company.id, actorType: "system", actorId: "devflow-qa", action: "agent.qa_run", entityType: "pipeline_case", entityId: agree.id, details: { ok: true, costUsd: 1.25 } },
      { companyId: ctx.company.id, actorType: "system", actorId: "devflow-dev", action: "agent.dev_run", entityType: "pipeline_case", entityId: agree.id, details: { ok: true, costUsd: 7 } },
    ]);
    await decide(ctx, agree, { decision: "approve" });
    await decide(ctx, approvedAgainst, { decision: "approve" });
    await decide(ctx, returnedAgainst, { decision: "request_changes", reason: "Tôi thấy chưa ổn" });
    await decide(ctx, agreeBack, { decision: "request_changes", reason: "AC2 sai" });
    const res = await get(ctx, "qa-metrics?days=30");
    expect(res.status).toBe(200);
    expect(res.body.recommendation).toEqual({ decided: 4, approvedAgainst: 1, returnedAgainst: 1, againstRate: 0.5 });
    expect(res.body.decisions).toMatchObject({ approve: 2, requestChanges: 2, reject: 0 });
    expect(res.body.agent).toMatchObject({ spendUsd: 1.25, runs: 1 });
  });

  // ---- the round trip back to Dev ----------------------------------------------------------------------------------
  describe("round trip to the Dev agent", () => {
    const runLog: string[] = [];
    function devRunner(): StageRunner {
      return {
        async run() {
          const dir = devWorkspaceDir(root);
          runLog.push(fs.readFileSync(path.join(dir, ".devflow", "request.md"), "utf8"));
          const repo = path.join(dir, REPOS_DIR, "portal");
          fs.writeFileSync(path.join(repo, "src", `fix-${runLog.length}.ts`), "fix\n");
          git(repo, "add", "-A");
          git(repo, "commit", "-q", "-m", "fix");
          const text = JSON.stringify({
            summary: "Đã sửa theo phản hồi.",
            tasks: [{ id: "T1", status: "done", notes: "Đã sửa." }, { id: "T2", status: "done", notes: "Đã sửa." }],
            checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "ok" }],
            openQuestions: [],
            risks: [],
            confidence: "medium",
          });
          return { runId: null, ok: true, text, subtype: "success", errorCode: null, costUsd: 1, inputTokens: 1000, outputTokens: 100, model: "m" } as StageRunResult;
        },
      };
    }
    const prepare = async (input: { dest: string; devBranch: string }) => {
      fs.mkdirSync(path.join(input.dest, "src"), { recursive: true });
      git(input.dest, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(input.dest, "src", "a.txt"), "one\n");
      git(input.dest, "add", "-A");
      git(input.dest, "commit", "-q", "-m", "base");
      const sha = git(input.dest, "rev-parse", "HEAD");
      git(input.dest, "checkout", "-q", "-b", input.devBranch);
      return { sha, resumed: true };
    };
    const githubForDev = () =>
      ({
        canPush: async () => true,
        isBranchProtected: async () => true,
        findOpenPr: async () => ({ number: 41, url: "https://github.com/acme/portal/pull/41", draft: true }),
        updatePr: async () => ({ number: 41, url: "https://github.com/acme/portal/pull/41", draft: true }),
        comment: async () => undefined,
        createDraftPr: async () => ({ number: 41, url: "https://github.com/acme/portal/pull/41", draft: true }),
        label: async () => undefined,
      }) as unknown as GithubClient;

    it("gives the next Dev run the signer's reason and what QA found, and not the old QA round after a later code review", async () => {
      const ctx = await seedCompany();
      const spec = devAgentSpec({ workspaceRoot: root });
      await db.insert(agents).values({
        companyId: ctx.company.id,
        name: spec.name,
        role: "general",
        adapterType: spec.adapterType,
        adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" },
        runtimeConfig: spec.runtimeConfig,
        metadata: spec.metadata,
        status: "idle",
        defaultEnvironmentId: runnerEnvId,
      });
      const failing = qaData("changes", { AC2: "fail" }, { issues: [{ severity: "high", title: "Lộ mã cho khách", steps: "Mở app khách" }] });
      const r = await seedRequest(ctx, { data: failing });
      const dev = () =>
        devService(db, {
          pipelines: svc(),
          runner: devRunner(),
          resolveToken: async () => "ghp_token",
          workspaceRoot: root,
          prepare: prepare as any,
          publishDeps: { github: githubForDev, push: async () => undefined } as any,
        });

      // QA sends it back
      expect((await decide(ctx, r, { decision: "request_changes", reason: "AC2 sai khi voucher hết hạn" })).status).toBe(200);
      expect(await stageOf(r.id)).toBe("dev");
      expect(await dev().runCase(ctx.company.id, r.id)).toBe("proposed");
      const first = runLog[runLog.length - 1]!;
      expect(first).toContain("AC2 sai khi voucher hết hạn");
      expect(first).toContain("QA found: AC2 (fail) Khách không thấy mã nội bộ: AC2: đã chạy test.");
      expect(first).toContain("issue [high] Lộ mã cho khách: Mở app khách");
      expect(first).not.toContain("AC1 (pass)"); // what passed is not repeated
      expect(await stageOf(r.id)).toBe("code_review");

      // a code reviewer sends the new work back later: that round has its own reason and no QA text
      const [proposal] = await db.select().from(drAgentOutputs).where(and(eq(drAgentOutputs.caseId, r.id), eq(drAgentOutputs.stageKey, "dev"), eq(drAgentOutputs.status, "proposed")));
      await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.id, proposal!.id));
      await db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId: r.id, type: "review_decided", actorType: "user", actorId: ctx.reviewer, payload: { decision: "request_changes", reason: "Thiếu test hết hạn" }, createdAt: new Date(Date.now() + 5000) });
      const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, r.id));
      await svc().transitionCase({ companyId: ctx.company.id, caseId: r.id, toStageKey: "dev", expectedVersion: c!.version, actor: { type: "user", userId: ctx.reviewer } });
      expect(await dev().runCase(ctx.company.id, r.id)).toBe("proposed");
      const second = runLog[runLog.length - 1]!;
      expect(second).toContain("Thiếu test hết hạn");
      expect(second).not.toContain("QA found");
      // and the Dev outputs are all in the record: nothing was deleted
      expect((await db.select().from(drAgentOutputs).where(and(eq(drAgentOutputs.caseId, r.id), eq(drAgentOutputs.stageKey, "dev"))).orderBy(desc(drAgentOutputs.createdAt))).length).toBeGreaterThanOrEqual(3);
    });
  });
});
