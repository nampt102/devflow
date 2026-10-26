import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, drAgentOutputs, drRequesters, drRequests, drSystems, environments, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { PROMPT_HASH } from "../devflow/prompts/qa.v1.js";
import type { StageRunResult, StageRunner } from "../devflow/agent-stage/runner.js";
import { createStageWorker } from "../devflow/agent-stage/worker.js";
import { DEV_RUNNER_ENVIRONMENT } from "../devflow/dev/agent.js";
import { REPOS_DIR } from "../devflow/dev/workspace.js";
import { qaAgentSpec, qaWorkspaceDir } from "../devflow/qa/agent.js";
import { qaService } from "../devflow/qa/qa-service.js";
import { APPROVED_BA_SPEC, VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";

// QA for one request (openspec/changes/add-qa-stage, task 3.5): the whole flow with a fake runner standing in for the agent on the
// runner (it can commit into a real git repository), against a real database. Nothing in this stage may reach GitHub.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  }).trim();

type Verdict = "pass" | "fail" | "not_verified";
const report = (over: Record<string, unknown> = {}, verdicts: Record<string, Verdict> = {}) => ({
  summary: "Hai tiêu chí đã kiểm.",
  criteria: ["AC1", "AC2"].map((id) => ({ id, verdict: verdicts[id] ?? "pass", how: "automated", evidence: `${id}: dotnet test đạt.` })),
  checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "6 passed" }],
  issues: [],
  manualTests: [],
  confidence: "medium",
  ...over,
});

type RunStep = Partial<StageRunResult> & { text?: string | null; commit?: boolean; during?: () => Promise<void> };

describeEmbeddedPostgres("devflow QA", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  let runnerEnvId: string;
  let baseSha: string;

  const branchOf = (caseKey: string) => `devflow/${caseKey}`;
  /** A real repository on the pull request's branch, in place of a clone from GitHub. Deterministic: the same sha every time. */
  const makeRepo = (dest: string, branch: string) => {
    fs.mkdirSync(path.join(dest, "src"), { recursive: true });
    git(dest, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dest, "src", "a.txt"), "one\n");
    git(dest, "add", "-A");
    git(dest, "commit", "-q", "-m", "base");
    git(dest, "checkout", "-q", "-b", branch);
    return git(dest, "rev-parse", "HEAD");
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-qa-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-qa-ws-"));
    const [env] = await db
      .insert(environments)
      .values({ name: DEV_RUNNER_ENVIRONMENT, driver: "ssh", config: { remoteWorkspacePath: root, knownHosts: "devflow-runner ssh-ed25519 AAAA", strictHostKeyChecking: true } })
      .returning();
    runnerEnvId = env!.id;
    baseSha = makeRepo(path.join(root, "probe"), "devflow/probe");
  }, 60_000);

  afterAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  // ---- fakes -------------------------------------------------------------------------------------------------------
  const repoDir = (key = "portal") => path.join(qaWorkspaceDir(root), REPOS_DIR, key);
  type Call = { agentId: string; request: string; repos: string[] };

  function fakeRunner(steps: RunStep[], fallback: string) {
    const calls: Call[] = [];
    const runner: StageRunner = {
      async run(input) {
        const dir = qaWorkspaceDir(root);
        const request = fs.readFileSync(path.join(dir, ".devflow", "request.md"), "utf8");
        calls.push({ agentId: input.agentId, request, repos: fs.readdirSync(path.join(dir, REPOS_DIR)) });
        const step = steps.shift() ?? { text: fallback };
        await step.during?.();
        const key = /key: ([a-z0-9-]+) \| directory/.exec(request)?.[1] ?? "portal";
        if (step.commit) {
          fs.writeFileSync(path.join(repoDir(key), "src", "qa-test.txt"), "added by the QA agent\n");
          git(repoDir(key), "add", "-A");
          git(repoDir(key), "commit", "-q", "-m", "qa commit");
        }
        const { during: _d, commit: _c, ...rest } = step;
        return { runId: null, ok: true, text: fallback, subtype: "success", errorCode: null, costUsd: 0.8, inputTokens: 40_000, outputTokens: 5000, model: "claude-sonnet-5-5", ...rest };
      },
    };
    return { runner, calls };
  }

  type Opts = { maxUsdPerDay?: number; missingBranch?: boolean };
  function makeQa(steps: RunStep[] = [], opts: Opts = {}) {
    const r = fakeRunner(steps, JSON.stringify(report()));
    const prepared: Array<Record<string, unknown>> = [];
    const service = qaService(db, {
      pipelines: pipelineService(db),
      runner: r.runner,
      resolveToken: async () => "ghp_token",
      workspaceRoot: root,
      maxUsdPerDay: opts.maxUsdPerDay,
      prepare: (async (input: { dest: string; devBranch: string; existingOnly?: boolean }) => {
        prepared.push({ existingOnly: input.existingOnly, devBranch: input.devBranch });
        if (opts.missingBranch) throw new Error("branch_missing");
        return { sha: makeRepo(input.dest, input.devBranch), resumed: true };
      }) as any,
    });
    return { service, runs: r.calls, prepared };
  }

  // ---- seeding -----------------------------------------------------------------------------------------------------
  async function seedCompany(opts: { agent?: "ok" | "none" | "no_environment" } = {}) {
    const [company] = await db
      .insert(companies)
      .values({ name: "QA Co", issuePrefix: `Q${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      { pipelineId: pipeline!.id, key: "dev", name: "Dev", kind: "working", position: 400 },
      { pipelineId: pipeline!.id, key: "qa", name: "QA", kind: "working", position: 500 },
      { pipelineId: pipeline!.id, key: "qa_signoff", name: "QA sign-off", kind: "review", position: 550, config: { approveToStageKey: "dev", rejectToStageKey: "dev", requestChangesToStageKey: "dev" } },
    ]);
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId }).returning();
    let agentId: string | null = null;
    if (opts.agent !== "none") {
      const spec = qaAgentSpec({ workspaceRoot: root });
      const [agent] = await db
        .insert(agents)
        .values({
          companyId: company!.id,
          name: spec.name,
          role: "general",
          adapterType: spec.adapterType,
          adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" },
          runtimeConfig: spec.runtimeConfig,
          metadata: spec.metadata,
          status: "idle",
          defaultEnvironmentId: opts.agent === "no_environment" ? null : runnerEnvId,
        })
        .returning();
      agentId = agent!.id;
    }
    return { company: company!, pipeline: pipeline!, userId, requester: requester!, agentId };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  type RepoSeed = { system: string; headSha?: string | null; prUrl?: string | null };
  let counter = 0;
  async function seedRequest(
    ctx: Ctx,
    over: { stage?: string; spec?: Record<string, unknown> | null; plan?: boolean; repos?: RepoSeed[]; dev?: boolean } = {},
  ) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: "Cho requester thấy người xử lý",
      stageKey: over.stage ?? "qa",
      actor: { type: "user", userId: ctx.userId },
    });
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "Người yêu cầu muốn thấy ai đang xử lý.", businessImpact: "Giảm email hỏi lại", classification: "feature", priority: "high", difficulty: "medium" });
    const approvedOutput = (stageKey: string, role: string, approved: unknown) =>
      db.insert(drAgentOutputs).values({ companyId: ctx.company.id, caseId: created.id, stageKey, promptRole: role, promptVersion: "v1", promptHash: "h", status: "accepted", decidedAt: new Date(), decidedByUserId: ctx.userId, data: { approved }, commentText: "x" });
    if (over.spec !== null) await approvedOutput("ba_spec", "ba", over.spec ?? { ...APPROVED_BA_SPEC, acceptanceCriteria: ["Trang yêu cầu hiện tên người xử lý", "Khách không thấy mã nội bộ"] });
    if (over.plan !== false) await approvedOutput("tech_plan", "plan", { ...VALID_PLAN_OUTPUT, testPlan: ["Test portal-service trả assigneeName"] });
    if (over.dev !== false) {
      const repos = (over.repos ?? [{ system: "portal" }]).map((r) => ({
        system: r.system,
        branch: branchOf(`REQ-${n}`),
        baseBranch: "main",
        baseSha: baseSha,
        headSha: r.headSha === undefined ? baseSha : r.headSha,
        prUrl: r.prUrl === undefined ? `https://github.com/acme/${r.system}/pull/${n}` : r.prUrl,
        prNumber: n,
      }));
      await approvedOutput("dev", "dev", {
        summary: "Đã thêm assigneeName và hiện trên trang.",
        tasks: [{ id: "T1", status: "done", notes: "Đã làm." }],
        checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "ok" }],
        repos,
      });
    }
    return created.id as string;
  }
  async function seedSystem(ctx: Ctx, key = "portal", over: Partial<typeof drSystems.$inferInsert> = {}) {
    const [existing] = await db.select().from(drSystems).where(and(eq(drSystems.companyId, ctx.company.id), eq(drSystems.key, key)));
    if (existing) return existing;
    const [system] = await db
      .insert(drSystems)
      .values({ companyId: ctx.company.id, key, name: key, repoUrl: `https://github.com/acme/${key}`, devEnabled: true, writeTokenSecretId: randomUUID(), testCommand: "npm test", ...over })
      .returning();
    return system!;
  }
  async function readyRequest(ctx: Ctx, over: Parameters<typeof seedRequest>[1] = {}, systemOver: Partial<typeof drSystems.$inferInsert> = {}) {
    const caseId = await seedRequest(ctx, over);
    await seedSystem(ctx, "portal", systemOver);
    return caseId;
  }
  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const qaOutputs = (caseId: string) => db.select().from(drAgentOutputs).where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "qa")));
  const activities = (companyId: string, action: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));

  // ---- the flow ----------------------------------------------------------------------------------------------------
  it("checks the pull request's branch against the numbered criteria, stores the report and sends the request to QA sign-off", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const t = makeQa();

    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");

    expect(await stageOf(caseId)).toBe("qa_signoff");
    const [out] = await qaOutputs(caseId);
    expect(out).toMatchObject({ status: "proposed", promptRole: "qa", promptVersion: "v1", promptHash: PROMPT_HASH, agentId: ctx.agentId });
    const data = out!.data as any;
    expect(data.criteria.map((c: any) => c.id)).toEqual(["AC1", "AC2"]);
    expect(data.recommendation).toEqual({ value: "approve", reasons: [] });
    expect(data.warnings).toEqual([]);
    expect(data.repos[0]).toMatchObject({ system: "portal", testedSha: baseSha, approvedSha: baseSha, prNumber: expect.any(Number) });
    expect(data.criteriaText).toEqual({ AC1: "Trang yêu cầu hiện tên người xử lý", AC2: "Khách không thấy mã nội bộ" });
    expect(out!.commentText).toContain("nên duyệt");
    expect(out!.commentText).toContain("AC1 (đạt, chạy tự động) Trang yêu cầu hiện tên người xử lý");

    // the agent got the numbered criteria, the approved test plan and the developer's claims, on the branch that exists
    const call = t.runs[0]!;
    expect(call.agentId).toBe(ctx.agentId);
    expect(call.repos).toEqual(["portal"]);
    expect(call.request).toContain("AC1: Trang yêu cầu hiện tên người xử lý");
    expect(call.request).toContain("AC2: Khách không thấy mã nội bộ");
    expect(call.request).toContain("- Test portal-service trả assigneeName");
    expect(call.request).toContain("claims, not evidence");
    expect(call.request).toContain("test command: npm test");
    expect(t.prepared).toEqual([{ existingOnly: true, devBranch: branchOf((await db.select().from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0]!.caseKey) }]);
    // nothing is left on disk
    expect(fs.existsSync(qaWorkspaceDir(root))).toBe(false);
    // its own ledger
    const [run] = await activities(ctx.company.id, "agent.qa_run");
    expect(run!.details).toMatchObject({ ok: true, costUsd: 0.8, promptVersion: "v1" });
    expect(run!.actorId).toBe("devflow-qa");
    expect(await activities(ctx.company.id, "agent.qa_proposed")).toHaveLength(1);
    expect(await activities(ctx.company.id, "agent.dev_run")).toHaveLength(0);
  });

  it("refuses to run unless the agent is on the runner, before any clone or run", async () => {
    const off = await seedCompany({ agent: "no_environment" });
    const t = makeQa();
    await expect(t.service.runCase(off.company.id, await readyRequest(off))).rejects.toMatchObject({ kind: "agent_not_on_runner" });
    const none = await seedCompany({ agent: "none" });
    await expect(t.service.runCase(none.company.id, await readyRequest(none))).rejects.toMatchObject({ kind: "no_agent" });
    expect(t.runs).toHaveLength(0);
    expect(t.prepared).toHaveLength(0);
  });

  it("needs approved criteria, an approved plan and an approved pull request in a system that is still in the catalog", async () => {
    const ctx = await seedCompany();
    const t = makeQa();
    for (const over of [{ spec: null }, { spec: { ...APPROVED_BA_SPEC, acceptanceCriteria: [] } }, { plan: false }]) {
      await expect(t.service.runCase(ctx.company.id, await readyRequest(ctx, over))).rejects.toMatchObject({ kind: "no_approved_spec" });
    }
    // no approved Dev work at all, Dev work without a pull request, a pull request of a system that is gone
    for (const over of [{ dev: false }, { repos: [{ system: "portal", prUrl: null }] }, { repos: [{ system: "ghost" }] }]) {
      await expect(t.service.runCase(ctx.company.id, await readyRequest(ctx, over))).rejects.toMatchObject({ kind: "no_qa_target" });
    }
    const other = await seedCompany();
    await expect(t.service.runCase(other.company.id, await readyRequest(other, {}, { active: false }))).rejects.toMatchObject({ kind: "no_qa_target" });
    expect(t.runs).toHaveLength(0);
  });

  it("stops with branch_missing when the pull request's branch is gone, without a run and with nothing left", async () => {
    const ctx = await seedCompany();
    const t = makeQa([], { missingBranch: true });
    await expect(t.service.runCase(ctx.company.id, await readyRequest(ctx))).rejects.toMatchObject({ kind: "branch_missing" });
    expect(t.runs).toHaveLength(0);
    expect(fs.existsSync(qaWorkspaceDir(root))).toBe(false);
    expect(await activities(ctx.company.id, "agent.qa_run")).toHaveLength(0);
  });

  it("asks once more with the reason when a criterion is missing or invented, and never stores a report it rejected", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const missing = JSON.stringify(report({ criteria: [{ id: "AC1", verdict: "pass", how: "automated", evidence: "e" }] })); // AC2 left out
    const t = makeQa([{ text: missing }, { text: missing }]);
    await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1]!.request).toContain("Write the report again");
    expect(t.runs[1]!.request).toContain("every acceptance criterion");
    expect(await qaOutputs(caseId)).toHaveLength(0);
    expect(await stageOf(caseId)).toBe("qa");
    expect(fs.existsSync(qaWorkspaceDir(root))).toBe(false);
    // a first wrong answer followed by a good one is accepted
    const second = await readyRequest(await seedCompany());
    const ok = makeQa([{ text: "xong rồi" }]);
    const c2 = (await db.select().from(pipelineCases).where(eq(pipelineCases.id, second)))[0]!;
    expect(await ok.service.runCase(c2.companyId, second)).toBe("proposed");
    expect(ok.runs).toHaveLength(2);
  });

  it("recommends changes, with the reasons, when a criterion failed or a command did not pass", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const bad = JSON.stringify(
      report(
        { checks: [{ system: "portal", command: "npm test", passed: false, outputTail: "1 failed" }], issues: [{ severity: "high", title: "Lộ mã", steps: "Mở app khách" }] },
        { AC2: "fail" },
      ),
    );
    const t = makeQa([{ text: bad }]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    const [out] = await qaOutputs(caseId);
    expect((out!.data as any).recommendation).toEqual({ value: "changes", reasons: ["criteria_failed:AC2", "checks_failed", "high_issue"] });
    expect(out!.commentText).toContain("nên trả lại");
  });

  it("throws away a commit the agent made and says so, and warns when the branch moved since the code was approved", async () => {
    const ctx = await seedCompany();
    const committed = await readyRequest(ctx);
    const t = makeQa([{ commit: true }]);
    expect(await t.service.runCase(ctx.company.id, committed)).toBe("proposed");
    const [out] = await qaOutputs(committed);
    const data = out!.data as any;
    expect(data.warnings).toEqual(["qa_modified_branch"]);
    expect(data.recommendation).toEqual({ value: "changes", reasons: ["qa_modified_branch"] });
    expect(data.repos[0].testedSha).toBe(baseSha); // what was checked is the branch as it was, not the agent's commit
    expect(fs.existsSync(qaWorkspaceDir(root))).toBe(false);

    const moved = await readyRequest(await seedCompany(), { repos: [{ system: "portal", headSha: "f".repeat(40) }] });
    const m = makeQa();
    const mc = (await db.select().from(pipelineCases).where(eq(pipelineCases.id, moved)))[0]!;
    expect(await m.service.runCase(mc.companyId, moved)).toBe("proposed");
    const [out2] = await qaOutputs(moved);
    expect((out2!.data as any).warnings).toEqual(["branch_moved"]);
    expect((out2!.data as any).repos[0]).toMatchObject({ approvedSha: "f".repeat(40), testedSha: baseSha });
    expect((out2!.data as any).recommendation.value).toBe("approve"); // a moved branch is a warning, not a verdict
  });

  it("maps a failed run to a kind and cleans up", async () => {
    for (const [step, kind] of [
      [{ ok: false, text: null, subtype: "error_max_budget_usd", errorCode: "claude_auth_required" }, "budget_exhausted"],
      [{ ok: false, text: null, errorCode: "run_timeout" }, "run_timeout"],
      [{ ok: false, text: null, errorCode: "wake_skipped" }, "wake_skipped"],
      [{ ok: false, text: null, errorCode: "adapter_failed" }, "run_failed"],
    ] as const) {
      const ctx = await seedCompany();
      const caseId = await readyRequest(ctx);
      const t = makeQa([{ ...step }]);
      await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind });
      expect(fs.existsSync(qaWorkspaceDir(root))).toBe(false);
      expect((await activities(ctx.company.id, "agent.qa_run"))[0]!.details).toMatchObject({ ok: false, kind });
      expect(await qaOutputs(caseId)).toHaveLength(0);
    }
  });

  it("checks each system on its own and joins the reports: fail over pass over not verified", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx, { repos: [{ system: "portal" }, { system: "api" }] });
    await seedSystem(ctx, "portal");
    await seedSystem(ctx, "api");
    const mk = (system: string, verdicts: Record<string, Verdict>, confidence: string) =>
      JSON.stringify(report({ checks: [{ system, command: `${system} test`, passed: true, outputTail: "" }], confidence }, verdicts));
    // systems are checked in key order: api first
    const t = makeQa([{ text: mk("api", { AC1: "pass", AC2: "not_verified" }, "high") }, { text: mk("portal", { AC1: "not_verified", AC2: "fail" }, "low") }]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.runs.map((r) => r.repos)).toEqual([["api"], ["portal"]]);
    expect(t.runs[0]!.request).toContain("key: api |");
    expect(t.runs[0]!.request).not.toContain("key: portal |");
    const [out] = await qaOutputs(caseId);
    const data = out!.data as any;
    expect(data.criteria.map((c: any) => [c.id, c.verdict])).toEqual([["AC1", "pass"], ["AC2", "fail"]]);
    expect(data.confidence).toBe("low");
    expect(data.checks).toHaveLength(2);
    expect(data.repos.map((r: any) => r.system)).toEqual(["api", "portal"]);
    expect(data.costUsd).toBeCloseTo(1.6);
  });

  // ---- worker ------------------------------------------------------------------------------------------------------
  describe("worker", () => {
    async function wipe() {
      await db.delete(activityLog);
      await db.delete(pipelineCases);
    }

    it("runs the next pending case, and pauses a company that spent its day's allowance without stopping the others", async () => {
      await wipe();
      const rich = await seedCompany();
      const richCase = await readyRequest(rich);
      const poor = await seedCompany();
      const poorCase = await readyRequest(poor);
      await db.insert(activityLog).values({ companyId: rich.company.id, actorType: "system", actorId: "devflow-qa", action: "agent.qa_run", entityType: "pipeline_case", entityId: richCase, details: { ok: true, costUsd: 30 } });
      const t = makeQa([], { maxUsdPerDay: 20 });
      const worker = createStageWorker(db, t.service, "qa");
      expect(await worker.sweep()).toBe(1);
      expect(await stageOf(poorCase)).toBe("qa_signoff");
      expect(await stageOf(richCase)).toBe("qa");
      expect(await activities(rich.company.id, "agent.qa_budget_paused")).toHaveLength(1);
    });

    it("retries a setup problem calmly and notes it once, without spending", async () => {
      await wipe();
      const ctx = await seedCompany({ agent: "no_environment" });
      const caseId = await readyRequest(ctx);
      let clock = 1_000_000;
      const t = makeQa();
      const worker = createStageWorker(db, t.service, "qa", { now: () => clock, configRetryMs: 300_000, baseBackoffMs: 60_000 });
      expect(await worker.sweep()).toBe(1);
      expect(await worker.sweep()).toBe(1);
      clock += 301_000;
      expect(await worker.sweep()).toBe(1);
      const failed = await activities(ctx.company.id, "agent.qa_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.details).toMatchObject({ kind: "agent_not_on_runner" });
      expect(await activities(ctx.company.id, "agent.qa_gave_up")).toHaveLength(0);
      expect(t.runs).toHaveLength(0);
      expect(await stageOf(caseId)).toBe("qa");
    });
  });
});
