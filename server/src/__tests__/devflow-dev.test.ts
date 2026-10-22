import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  environments,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { PROMPT_HASH } from "../devflow/prompts/dev.v1.js";
import type { StageRunResult, StageRunner } from "../devflow/agent-stage/runner.js";
import { createStageWorker } from "../devflow/agent-stage/worker.js";
import { DEV_RUNNER_ENVIRONMENT, devAgentSpec, devWorkspaceDir } from "../devflow/dev/agent.js";
import { devService } from "../devflow/dev/dev-service.js";
import type { GithubClient } from "../devflow/dev/github.js";
import { REPOS_DIR } from "../devflow/dev/workspace.js";
import { APPROVED_BA_SPEC, VALID_PLAN_OUTPUT } from "./helpers/plan-fixtures.js";
import { VALID_BA_OUTPUT } from "./helpers/ba-fixtures.js";

// Dev for one request (openspec/changes/add-dev-stage, task 3.6): the whole flow with a fake runner standing in for the
// agent on the runner (it commits into a real git repository), the real diff check and publish code, and a fake GitHub,
// against a real database.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

type RunStep = Partial<StageRunResult> & { text?: string | null; commit?: Record<string, string>; during?: () => Promise<void> };

const report = (over: Record<string, unknown> = {}) => ({
  summary: "Đã thêm assigneeName vào DTO và hiện trên trang yêu cầu.",
  tasks: [
    { id: "T1", status: "done", notes: "Đã thêm trường." },
    { id: "T2", status: "done", notes: "Đã hiện trên trang." },
  ],
  checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "6 passed" }],
  openQuestions: [],
  risks: [],
  confidence: "medium",
  ...over,
});

describeEmbeddedPostgres("devflow Dev", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  let runnerEnvId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-dev-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-dev-ws-"));
    // environments are not company data: one runner for the instance, as in a real deployment
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

  // ---- fakes -------------------------------------------------------------------------------------------------------
  const repoDir = (key = "portal") => path.join(devWorkspaceDir(root), REPOS_DIR, key);
  type Call = { agentId: string; request: string; repos: string[] };

  function fakeRunner(steps: RunStep[], fallback: string) {
    const calls: Call[] = [];
    const runner: StageRunner = {
      async run(input) {
        const dir = devWorkspaceDir(root);
        const request = fs.readFileSync(path.join(dir, ".devflow", "request.md"), "utf8");
        calls.push({ agentId: input.agentId, request, repos: fs.readdirSync(path.join(dir, REPOS_DIR)) });
        const step = steps.shift() ?? { text: fallback };
        await step.during?.();
        // the agent works in the repository of the system it was given
        const key = /key: ([a-z0-9-]+) \| directory/.exec(request)?.[1] ?? "portal";
        for (const [file, content] of Object.entries(step.commit ?? {})) {
          fs.mkdirSync(path.dirname(path.join(repoDir(key), file)), { recursive: true });
          fs.writeFileSync(path.join(repoDir(key), file), content);
        }
        if (step.commit) {
          git(repoDir(key), "add", "-A");
          git(repoDir(key), "commit", "-q", "-m", "agent work");
        }
        const { during: _d, commit: _c, ...rest } = step;
        return { runId: null, ok: true, text: fallback, subtype: "success", errorCode: null, costUsd: 1.5, inputTokens: 90_000, outputTokens: 8000, model: "claude-sonnet-5-5", ...rest };
      },
    };
    return { runner, calls };
  }

  /** A real repository with a base commit on the request's branch, in place of a clone from GitHub. */
  const prepare = async (input: { dest: string; devBranch: string }) => {
    fs.mkdirSync(path.join(input.dest, "src"), { recursive: true });
    git(input.dest, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(input.dest, "src", "a.txt"), "one\n");
    git(input.dest, "add", "-A");
    git(input.dest, "commit", "-q", "-m", "base");
    const sha = git(input.dest, "rev-parse", "HEAD");
    git(input.dest, "checkout", "-q", "-b", input.devBranch);
    return { sha, resumed: false };
  };

  function fakeGithub(opts: { protected?: boolean; canPush?: boolean } = {}) {
    const log: string[] = [];
    const client = {
      canPush: async () => (log.push("canPush"), opts.canPush ?? true),
      isBranchProtected: async () => (log.push("protected"), opts.protected ?? true),
      findOpenPr: async () => (log.push("find"), null),
      createDraftPr: async () => (log.push("create"), { number: 41, url: "https://github.com/acme/portal/pull/41", draft: true }),
      updatePr: async () => log.push("update"),
      comment: async () => log.push("comment"),
      label: async () => log.push("label"),
    } as unknown as GithubClient;
    return { log, publishDeps: { github: () => client, push: async () => void log.push("push") } };
  }

  type Opts = { maxUsdPerDay?: number; protected?: boolean; canPush?: boolean; token?: string | null; resolve?: (secretId: string) => string | null };
  function makeDev(steps: RunStep[] = [], opts: Opts = {}) {
    const r = fakeRunner(steps, JSON.stringify(report()));
    const gh = fakeGithub(opts);
    const service = devService(db, {
      pipelines: pipelineService(db),
      runner: r.runner,
      resolveToken: async (_company: string, secretId: string) => (opts.resolve ? opts.resolve(secretId) : opts.token === undefined ? "ghp_token" : opts.token),
      workspaceRoot: root,
      maxUsdPerDay: opts.maxUsdPerDay,
      prepare: prepare as any,
      publishDeps: gh.publishDeps as any,
      caseUrl: (id) => `https://devflow.example/requests/${id}`,
    });
    return { service, runs: r.calls, github: gh.log };
  }

  // ---- seeding -----------------------------------------------------------------------------------------------------
  async function seedCompany(opts: { agent?: "ok" | "none" | "no_environment" } = {}) {
    const [company] = await db
      .insert(companies)
      .values({ name: "Dev Co", issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      { pipelineId: pipeline!.id, key: "tech_plan", name: "Tech Plan", kind: "working", position: 300 },
      { pipelineId: pipeline!.id, key: "dev", name: "Dev", kind: "working", position: 400 },
      { pipelineId: pipeline!.id, key: "code_review", name: "Code review", kind: "review", position: 450, config: { approveToStageKey: "dev", rejectToStageKey: "dev" } },
    ]);
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId }).returning();
    let agentId: string | null = null;
    if (opts.agent !== "none") {
      const spec = devAgentSpec({ workspaceRoot: root });
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

  let counter = 0;
  async function seedRequest(ctx: Ctx, over: { stage?: string; plan?: Record<string, unknown> | null; spec?: boolean } = {}) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: "Cho requester thấy người xử lý",
      stageKey: over.stage ?? "dev",
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
    const approvedOutput = (stageKey: string, role: string, approved: unknown) =>
      db.insert(drAgentOutputs).values({
        companyId: ctx.company.id,
        caseId: created.id,
        stageKey,
        promptRole: role,
        promptVersion: "v1",
        promptHash: "h",
        status: "accepted",
        decidedAt: new Date(),
        decidedByUserId: ctx.userId,
        data: { approved },
        commentText: "x",
      });
    if (over.spec !== false) await approvedOutput("ba_spec", "ba", APPROVED_BA_SPEC);
    if (over.plan !== null) await approvedOutput("tech_plan", "plan", over.plan ?? VALID_PLAN_OUTPUT);
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
  const assign = (ctx: Ctx, caseId: string, systemId: string) => db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId, systemId });
  async function readyRequest(ctx: Ctx, over: Parameters<typeof seedRequest>[1] = {}, systemOver: Partial<typeof drSystems.$inferInsert> = {}) {
    const caseId = await seedRequest(ctx, over);
    await assign(ctx, caseId, (await seedSystem(ctx, "portal", systemOver)).id);
    return caseId;
  }
  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const devOutputs = (caseId: string) => db.select().from(drAgentOutputs).where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "dev")));
  const activities = (companyId: string, action: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));

  // ---- the flow ----------------------------------------------------------------------------------------------------
  it("runs the agent on the approved plan, publishes a draft pull request and sends the request to code review", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const t = makeDev([{ commit: { "src/a.txt": "one\ntwo\n", "src/new.ts": "export const x = 1;\n" } }]);

    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");

    expect(await stageOf(caseId)).toBe("code_review");
    const [out] = await devOutputs(caseId);
    expect(out).toMatchObject({ status: "proposed", promptRole: "dev", promptVersion: "v1", promptHash: PROMPT_HASH, agentId: ctx.agentId });
    const repos = (out!.data as any).repos;
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ system: "portal", branch: expect.stringMatching(/^devflow\/REQ-\d+$/), prNumber: 41, prUrl: "https://github.com/acme/portal/pull/41", filesChanged: 2, additions: 2, newPr: true });
    expect((out!.data as any).costUsd).toBe(1.5);
    expect(out!.commentText).toContain("[PR nháp #41](https://github.com/acme/portal/pull/41)");
    expect(t.github).toEqual(["canPush", "protected", "push", "find", "create", "label"]);

    const call = t.runs[0]!;
    expect(call.agentId).toBe(ctx.agentId);
    expect(call.repos).toEqual(["portal"]);
    expect(call.request).toContain(`directory: ${REPOS_DIR}/portal/`);
    expect(call.request).toContain("Trang yêu cầu hiện tên người xử lý (đã sửa bởi người duyệt)");
    expect(call.request).toContain("T1 [S] system portal");
    expect(call.request).toContain("test command: npm test");
    // nothing of the request is left on disk
    expect(fs.existsSync(devWorkspaceDir(root))).toBe(false);
    // its own ledger
    const [run] = await activities(ctx.company.id, "agent.dev_run");
    expect(run!.details).toMatchObject({ ok: true, costUsd: 1.5, promptVersion: "v1" });
    expect(run!.actorId).toBe("devflow-dev");
    expect(await activities(ctx.company.id, "agent.dev_proposed")).toHaveLength(1);
    expect(await activities(ctx.company.id, "agent.ba_run")).toHaveLength(0);
  });

  it("refuses to run unless the agent is on the runner, before any clone or run", async () => {
    const off = await seedCompany({ agent: "no_environment" });
    const offCase = await readyRequest(off);
    const t = makeDev();
    await expect(t.service.runCase(off.company.id, offCase)).rejects.toMatchObject({ kind: "agent_not_on_runner" });
    const none = await seedCompany({ agent: "none" });
    await expect(t.service.runCase(none.company.id, await readyRequest(none))).rejects.toMatchObject({ kind: "no_agent" });
    // a Dev agent that someone gave one more tool
    const loosened = await seedCompany();
    const [a] = await db.select().from(agents).where(eq(agents.id, loosened.agentId!));
    await db.update(agents).set({ adapterConfig: { ...(a!.adapterConfig as object), extraArgs: ["--tools", "Read,Grep,Glob,Edit,Write,Bash,WebFetch", "--max-budget-usd", "5"] } }).where(eq(agents.id, a!.id));
    await expect(t.service.runCase(loosened.company.id, await readyRequest(loosened))).rejects.toMatchObject({ kind: "agent_tools_changed" });
    expect(t.runs).toHaveLength(0);
    expect(fs.existsSync(devWorkspaceDir(root))).toBe(false);
  });

  it("needs an approved plan and a system with Dev switched on that has tasks in the plan", async () => {
    const ctx = await seedCompany();
    const t = makeDev();
    const noPlan = await readyRequest(ctx, { plan: null });
    await expect(t.service.runCase(ctx.company.id, noPlan)).rejects.toMatchObject({ kind: "no_approved_plan" });
    const noSpec = await readyRequest(ctx, { spec: false });
    await expect(t.service.runCase(ctx.company.id, noSpec)).rejects.toMatchObject({ kind: "no_approved_plan" });
    // the plan has tasks for "portal", but Dev is switched off for it
    const offCompany = await seedCompany();
    const off = await readyRequest(offCompany, {}, { devEnabled: false, writeTokenSecretId: null });
    await expect(t.service.runCase(offCompany.company.id, off)).rejects.toMatchObject({ kind: "no_dev_system" });
    const elsewhere = await seedRequest(ctx); // the plan's tasks are all for "portal"
    await assign(ctx, elsewhere, (await seedSystem(ctx, "billing")).id);
    await expect(t.service.runCase(ctx.company.id, elsewhere)).rejects.toMatchObject({ kind: "no_dev_system" });
    const other = await seedCompany();
    const inactive = await readyRequest(other, {}, { active: false });
    await expect(t.service.runCase(other.company.id, inactive)).rejects.toMatchObject({ kind: "no_dev_system" });
    expect(t.runs).toHaveLength(0);
  });

  it("stops before spending anything when the write token is gone", async () => {
    const ctx = await seedCompany();
    const readId = randomUUID();
    const writeId = randomUUID();
    const caseId = await readyRequest(ctx, {}, { tokenSecretId: readId, writeTokenSecretId: writeId });
    // the read token still works (the clone would succeed); only the write token is gone
    const t = makeDev([{ commit: { "src/x.ts": "x\n" } }], { resolve: (id) => (id === writeId ? null : "ghp_read") });
    await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "system_missing_token" });
    expect(t.runs).toHaveLength(0);
    expect(t.github).toEqual([]);
    expect(await activities(ctx.company.id, "agent.dev_run")).toHaveLength(0);
  });

  it("keeps a diff that touches a forbidden path off GitHub and tells the reviewer why", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const t = makeDev([{ commit: { "src/ok.ts": "ok\n", ".github/workflows/deploy.yml": "name: x\n" } }]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.github).toEqual([]);
    const [out] = await devOutputs(caseId);
    expect((out!.data as any).repos[0]).toMatchObject({ system: "portal", blocked: { kind: "forbidden_paths", paths: [".github/workflows/deploy.yml"] } });
    expect(out!.commentText).toContain("KHÔNG đẩy lên GitHub");
    expect(out!.commentText).toContain(".github/workflows/deploy.yml");
    expect(await stageOf(caseId)).toBe("code_review");
  });

  it("records a run with no commit as a proposal without a pull request", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const t = makeDev([{}]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.github).toEqual([]);
    const [out] = await devOutputs(caseId);
    expect((out!.data as any).repos[0]).toMatchObject({ system: "portal", noChanges: true });
    expect(out!.commentText).toContain("không commit gì");
  });

  it("does not push to a repository whose default branch is unprotected, unless the owner allowed it", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const refused = makeDev([{ commit: { "src/x.ts": "x\n" } }], { protected: false });
    await expect(refused.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "repo_unprotected" });
    expect(refused.github).toEqual(["canPush", "protected"]);
    expect(await stageOf(caseId)).toBe("dev");
    expect(await devOutputs(caseId)).toHaveLength(0);
    expect(fs.existsSync(devWorkspaceDir(root))).toBe(false);

    const other = await seedCompany();
    const allowed = await readyRequest(other, {}, { allowUnprotected: true });
    const t = makeDev([{ commit: { "src/x.ts": "x\n" } }], { protected: false });
    expect(await t.service.runCase(other.company.id, allowed)).toBe("proposed");
    const [out] = await devOutputs(allowed);
    expect((out!.data as any).repos[0].unprotectedWarning).toBe(true);
    expect(out!.commentText).toContain("không được bảo vệ");
  });

  it("asks once more with the reason when the report is wrong, and never pushes a report it rejected", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const t = makeDev([{ text: "xong rồi", commit: { "src/x.ts": "x\n" } }]);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1]!.request).toContain("Write the report again");
    expect(t.runs[1]!.request).toContain("not a JSON object");
    expect(await activities(ctx.company.id, "agent.dev_run")).toHaveLength(2);

    const second = await seedCompany();
    const bad = await readyRequest(second);
    const omitted = JSON.stringify(report({ tasks: [{ id: "T1", status: "done", notes: "n" }] })); // T2 missing
    const u = makeDev([{ text: omitted, commit: { "src/x.ts": "x\n" } }, { text: omitted }]);
    await expect(u.service.runCase(second.company.id, bad)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(u.runs[1]!.request).toContain("every task of the plan");
    expect(u.github).toEqual([]);
    expect(await stageOf(bad)).toBe("dev");
    expect(fs.existsSync(devWorkspaceDir(root))).toBe(false);
  });

  it("maps a failed run to a kind, pushes nothing and cleans up", async () => {
    for (const [step, kind] of [
      [{ ok: false, text: null, subtype: "error_max_budget_usd", errorCode: "claude_auth_required" }, "budget_exhausted"],
      [{ ok: false, text: null, errorCode: "run_timeout" }, "run_timeout"],
      [{ ok: false, text: null, errorCode: "wake_skipped" }, "wake_skipped"],
      [{ ok: false, text: null, errorCode: "adapter_failed" }, "run_failed"],
    ] as const) {
      const ctx = await seedCompany();
      const caseId = await readyRequest(ctx);
      const t = makeDev([{ ...step, commit: { "src/x.ts": "x\n" } }]);
      await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind });
      expect(t.github).toEqual([]);
      expect(fs.existsSync(devWorkspaceDir(root))).toBe(false);
      expect((await activities(ctx.company.id, "agent.dev_run"))[0]!.details).toMatchObject({ ok: false, kind });
    }
  });

  it("passes GitHub failures on as kinds: a token that cannot push is a setup problem, a rejected push is retried", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const t = makeDev([{ commit: { "src/x.ts": "x\n" } }], { canPush: false });
    await expect(t.service.runCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "write_token_cannot_push" });
    expect(t.github).toEqual(["canPush"]);
  });

  it("gives the agent the code reviewer's reason after request_changes", async () => {
    const ctx = await seedCompany();
    const caseId = await readyRequest(ctx);
    const first = makeDev([{ commit: { "src/x.ts": "x\n" } }]);
    await first.service.runCase(ctx.company.id, caseId);
    expect(first.runs[0]!.request).not.toContain("REVIEWER FEEDBACK");
    await db.update(drAgentOutputs).set({ status: "superseded" }).where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "dev")));
    await db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId, type: "review_decided", actorType: "user", actorId: ctx.userId, payload: { decision: "request_changes", reason: "thiếu test voucher hết hạn" }, createdAt: new Date(Date.now() + 1000) });
    const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
    await pipelineService(db).transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "dev", expectedVersion: c!.version, actor: { type: "user", userId: ctx.userId } });
    const second = makeDev([{ commit: { "src/y.ts": "y\n" } }]);
    expect(await second.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(second.runs[0]!.request).toContain("thiếu test voucher hết hạn");
    expect(second.runs[0]!.request).toContain("REVIEWER FEEDBACK");
  });

  it("codes each system on its own, with only its tasks, and joins the reports", async () => {
    const ctx = await seedCompany();
    const plan = {
      ...VALID_PLAN_OUTPUT,
      tasks: [
        VALID_PLAN_OUTPUT.tasks[0]!,
        { ...VALID_PLAN_OUTPUT.tasks[1]!, system: "api", files: [], dependsOn: [] },
      ],
    };
    const caseId = await seedRequest(ctx, { plan });
    await assign(ctx, caseId, (await seedSystem(ctx, "portal")).id);
    await assign(ctx, caseId, (await seedSystem(ctx, "api")).id);
    const byKey: Record<string, string> = {
      portal: JSON.stringify(report({ tasks: [{ id: "T1", status: "done", notes: "a" }], checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "" }], confidence: "high" })),
      api: JSON.stringify(report({ tasks: [{ id: "T2", status: "partial", notes: "b" }], checks: [{ system: "api", command: "dotnet test", passed: false, outputTail: "1 failed" }], confidence: "low" })),
    };
    const steps: RunStep[] = [
      // systems are coded in key order: api first
      { text: byKey.api, commit: { "src/q.ts": "q\n" } },
      { text: byKey.portal, commit: { "src/p.ts": "p\n" } },
    ];
    const t = makeDev(steps);
    expect(await t.service.runCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.runs.map((r) => r.repos)).toEqual([["api"], ["portal"]]);
    expect(t.runs[0]!.request).toContain("T2 [M] system api");
    expect(t.runs[0]!.request).not.toContain("T1 [S]");
    expect(t.runs[0]!.request).toContain("Tasks T1 belong to systems you do not work on");
    expect(t.runs[1]!.request).toContain("T1 [S] system portal");
    const [out] = await devOutputs(caseId);
    const data = out!.data as any;
    expect(data.repos.map((r: any) => r.system)).toEqual(["api", "portal"]);
    expect(data.tasks.map((x: any) => x.id).sort()).toEqual(["T1", "T2"]);
    expect(data.checks).toHaveLength(2);
    expect(data.confidence).toBe("low");
    expect(data.costUsd).toBe(3);
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
      await db.insert(activityLog).values({ companyId: rich.company.id, actorType: "system", actorId: "devflow-dev", action: "agent.dev_run", entityType: "pipeline_case", entityId: richCase, details: { ok: true, costUsd: 60 } });
      const t = makeDev([{ commit: { "src/x.ts": "x\n" } }], { maxUsdPerDay: 50 });
      const worker = createStageWorker(db, t.service, "dev");
      expect(await worker.sweep()).toBe(1);
      expect(await stageOf(poorCase)).toBe("code_review");
      expect(await stageOf(richCase)).toBe("dev");
      expect(await activities(rich.company.id, "agent.dev_budget_paused")).toHaveLength(1);
    });

    it("retries a setup problem calmly and notes it once, and backs off a run that failed", async () => {
      await wipe();
      const ctx = await seedCompany({ agent: "no_environment" });
      const caseId = await readyRequest(ctx);
      let clock = 1_000_000;
      const t = makeDev();
      const worker = createStageWorker(db, t.service, "dev", { now: () => clock, configRetryMs: 300_000, baseBackoffMs: 60_000 });
      expect(await worker.sweep()).toBe(1);
      expect(await worker.sweep()).toBe(1); // still inside the retry delay: counted as picked, not run
      clock += 301_000;
      expect(await worker.sweep()).toBe(1);
      const failed = await activities(ctx.company.id, "agent.dev_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.details).toMatchObject({ kind: "agent_not_on_runner" });
      expect(await activities(ctx.company.id, "agent.dev_gave_up")).toHaveLength(0);
      expect(t.runs).toHaveLength(0);
      expect(await stageOf(caseId)).toBe("dev");
    });
  });
});
