import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
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
import { PROMPT_HASH } from "../devflow/prompts/ba.v1.js";
import { baAgentSpec, baWorkspaceDir } from "../devflow/ba/agent.js";
import { baService, BaFailure } from "../devflow/ba/ba-service.js";
import type { BaRunResult, BaRunner } from "../devflow/ba/runner.js";
import { createBaWorker } from "../devflow/ba/worker.js";
import { VALID_BA_OUTPUT } from "./helpers/ba-fixtures.js";

// BA Spec for one request (openspec/changes/add-ba-spec-stage, tasks 3.3 to 3.6): the whole flow with a fake
// runner and a fake clone, against a real database.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type RunStep = Partial<BaRunResult> & { text?: string | null; during?: () => Promise<void> };

describeEmbeddedPostgres("devflow BA spec", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  const workspace = () => baWorkspaceDir(root);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-ba-");
    db = createDb(tempDb.connectionString);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-ba-ws-"));
  }, 60_000);

  afterAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  // ---- fakes -------------------------------------------------------------------------------------------------------
  function fakeRunner(steps: RunStep[]) {
    const calls: Array<{ agentId: string; caseId: string; request: string; repos: string[] }> = [];
    const runner: BaRunner = {
      async run(input) {
        const request = fs.readFileSync(path.join(workspace(), ".devflow", "request.md"), "utf8");
        const repos = fs.readdirSync(path.join(workspace(), "repos"));
        calls.push({ agentId: input.agentId, caseId: input.caseId, request, repos });
        const step = steps.shift() ?? { text: JSON.stringify(VALID_BA_OUTPUT) };
        await step.during?.();
        const { during: _during, ...rest } = step;
        return { runId: null, ok: true, text: JSON.stringify(VALID_BA_OUTPUT), subtype: "success", errorCode: null, costUsd: 0.1, inputTokens: 1000, outputTokens: 200, model: "claude-haiku-5-5", ...rest };
      },
    };
    return { runner, calls };
  }
  function fakeClone() {
    const calls: Array<{ repoUrl: string; branch: string; token: string | null | undefined; dest: string }> = [];
    let failWith: string | null = null;
    const clone = async (input: { repoUrl: string; branch: string; dest: string; token?: string | null }) => {
      calls.push({ repoUrl: input.repoUrl, branch: input.branch, token: input.token, dest: input.dest });
      if (failWith) throw new Error(failWith);
      fs.mkdirSync(path.join(input.dest, "docs"), { recursive: true });
      fs.writeFileSync(path.join(input.dest, "docs", "rules.md"), "# Quy tắc\n");
      return { sha: "0123456789abcdef0123456789abcdef01234567" };
    };
    return { clone, calls, failWith: (m: string | null) => (failWith = m) };
  }
  const tokens = new Map<string, string>();
  const make = (steps: RunStep[] = [], opts: { maxUsdPerDay?: number } = {}) => {
    const r = fakeRunner(steps);
    const c = fakeClone();
    const service = baService(db, {
      pipelines: pipelineService(db),
      runner: r.runner,
      clone: c.clone as any,
      resolveToken: async (_company, secretId) => tokens.get(secretId) ?? null,
      workspaceRoot: root,
      maxUsdPerDay: opts.maxUsdPerDay,
    });
    return { service, runs: r.calls, clones: c.calls, cloneFails: c.failWith };
  };

  // ---- seeding -----------------------------------------------------------------------------------------------------
  async function seedCompany(withAgent = true) {
    const [company] = await db
      .insert(companies)
      .values({ name: "BA Co", issuePrefix: `B${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 100 },
      { pipelineId: pipeline!.id, key: "ba_spec", name: "BA Spec", kind: "working", position: 200 },
      { pipelineId: pipeline!.id, key: "ba_review", name: "BA Review", kind: "review", position: 250, config: { approveToStageKey: "ba_spec", rejectToStageKey: "ba_spec" } },
    ]);
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company!.id, userId }).returning();
    const spec = baAgentSpec({ workspaceRoot: root });
    let agentId: string | null = null;
    if (withAgent) {
      const [agent] = await db
        .insert(agents)
        .values({ companyId: company!.id, name: spec.name, role: "general", adapterType: spec.adapterType, adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" }, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, status: "idle" })
        .returning();
      agentId = agent!.id;
    }
    return { company: company!, pipeline: pipeline!, userId, requester: requester!, agentId };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  async function seedRequest(ctx: Ctx, over: { stage?: string; title?: string } = {}) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: over.title ?? "Cho requester thấy người xử lý",
      stageKey: over.stage ?? "ba_spec",
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
    return created.id as string;
  }
  async function seedSystem(ctx: Ctx, key = "portal", over: Record<string, unknown> = {}) {
    const [system] = await db
      .insert(drSystems)
      .values({ companyId: ctx.company.id, key, name: key, repoUrl: `https://github.com/acme/${key}`, ...over })
      .returning();
    return system!;
  }
  const assign = (ctx: Ctx, caseId: string, systemId: string) => db.insert(drRequestSystems).values({ companyId: ctx.company.id, caseId, systemId });

  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const outputsOf = (caseId: string) => db.select().from(drAgentOutputs).where(eq(drAgentOutputs.caseId, caseId));
  const activities = (companyId: string, action: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  const workspaceExists = () => fs.existsSync(workspace());

  // the requests and the activity of earlier tests, so a test that looks at everything starts from nothing
  async function wipe() {
    await db.delete(activityLog);
    await db.delete(pipelineCases);
  }

  // ---- tests -------------------------------------------------------------------------------------------------------
  it("runs the agent on the assigned repositories, stores the proposal and sends the request to BA review", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const system = await seedSystem(ctx, "portal", { tokenSecretId: randomUUID(), docsPath: "docs/business" });
    tokens.set(system.tokenSecretId!, "ghp_TOKEN_FOR_PORTAL");
    await assign(ctx, caseId, system.id);
    const t = make();

    expect(await t.service.baCase(ctx.company.id, caseId)).toBe("proposed");

    expect(await stageOf(caseId)).toBe("ba_review");
    const [out] = await outputsOf(caseId);
    expect(out).toMatchObject({ status: "proposed", stageKey: "ba_spec", promptRole: "ba", promptVersion: "v1", promptHash: PROMPT_HASH, agentId: ctx.agentId });
    expect((out!.data as any).summary).toBe(VALID_BA_OUTPUT.summary);
    expect((out!.data as any).repos).toEqual([{ system: "portal", sha: "0123456789abcdef0123456789abcdef01234567" }]);
    expect(out!.commentText).toContain("**Tiêu chí nghiệm thu**");

    // what the agent was given
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]!.agentId).toBe(ctx.agentId);
    expect(t.runs[0]!.repos).toEqual(["portal"]);
    const request = t.runs[0]!.request;
    expect(request).toContain("# Request REQ-");
    expect(request).toContain("classification: feature");
    expect(request).toContain("repos/portal/docs/business");
    expect(request).toContain("commit 0123456789ab");
    expect(request).toContain("Người yêu cầu muốn thấy ai đang xử lý");
    expect(t.clones).toEqual([expect.objectContaining({ repoUrl: "https://github.com/acme/portal", branch: "main", token: "ghp_TOKEN_FOR_PORTAL" })]);
    expect(t.clones[0]!.dest).toBe(path.join(workspace(), "repos", "portal"));

    // nothing of the request is left on disk
    expect(workspaceExists()).toBe(false);
    // the ledger and the audit trail
    const [run] = await activities(ctx.company.id, "agent.ba_run");
    expect(run!.details).toMatchObject({ ok: true, costUsd: 0.1, inputTokens: 1000, outputTokens: 200 });
    expect(await activities(ctx.company.id, "agent.ba_proposed")).toHaveLength(1);
    expect(JSON.stringify(run!.details)).not.toContain("ghp_TOKEN_FOR_PORTAL");
  });

  it("works without a system, saying so in the request, and then no area may be claimed", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] });
    const t = make([{ text: noAreas }]);
    expect(await t.service.baCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.runs[0]!.request).toContain("(none assigned)");
    expect(t.clones).toHaveLength(0);
    // an answer that cites a repository nobody assigned is refused (also on the retry)
    const second = await seedRequest(ctx);
    const t2 = make();
    await expect(t2.service.baCase(ctx.company.id, second)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(t2.runs).toHaveLength(2);
  });

  it("starts from an empty folder even when an earlier run was cut off and left files behind", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    fs.mkdirSync(path.join(workspace(), "repos", "other-company-repo"), { recursive: true });
    fs.mkdirSync(path.join(workspace(), ".devflow"), { recursive: true });
    fs.writeFileSync(path.join(workspace(), ".devflow", "old-request.md"), "another request");
    const t = make([{ text: JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] }) }]);
    await t.service.baCase(ctx.company.id, caseId);
    expect(t.runs[0]!.repos).toEqual([]);
    expect(t.runs[0]!.request).not.toContain("another request");
  });

  it("skips systems that are switched off", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const on = await seedSystem(ctx, "on");
    const off = await seedSystem(ctx, "off", { active: false });
    await assign(ctx, caseId, on.id);
    await assign(ctx, caseId, off.id);
    const t = make([{ text: JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [{ ...VALID_BA_OUTPUT.affectedAreas[0], system: "on" }] }) }]);
    await t.service.baCase(ctx.company.id, caseId);
    expect(t.clones.map((c) => c.repoUrl)).toEqual(["https://github.com/acme/on"]);
  });

  it("asks once more when the answer is rejected, telling the agent why, and adds up the cost", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const system = await seedSystem(ctx);
    await assign(ctx, caseId, system.id);
    const t = make([{ text: "Tôi đã xong, không có JSON", costUsd: 0.2 }, {}]);
    expect(await t.service.baCase(ctx.company.id, caseId)).toBe("proposed");
    expect(t.runs).toHaveLength(2);
    expect(t.runs[0]!.request).not.toContain("## Correction");
    expect(t.runs[1]!.request).toContain("## Correction");
    expect(t.runs[1]!.request).toContain("output is not a JSON object");
    expect(t.runs[1]!.request).not.toContain("Tôi đã xong"); // the agent's own text is never fed back
    const [out] = await outputsOf(caseId);
    expect((out!.data as any).costUsd).toBeCloseTo(0.3);
    expect((out!.data as any).inputTokens).toBe(2000);
    expect(await activities(ctx.company.id, "agent.ba_run")).toHaveLength(2);
  });

  it("gives up after a second rejected answer: no proposal, the request stays in BA Spec, the folder is emptied", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const t = make([{ text: "nope" }, { text: "still nope" }]);
    await expect(t.service.baCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(await outputsOf(caseId)).toHaveLength(0);
    expect(await stageOf(caseId)).toBe("ba_spec");
    expect(workspaceExists()).toBe(false);
  });

  it.each([
    ["ran out of its per-run budget (the adapter says claude_auth_required, the subtype tells the truth)", { ok: false, text: null, subtype: "error_max_budget_usd", errorCode: "claude_auth_required", costUsd: 1.02 }, "budget_exhausted"],
    ["timed out", { ok: false, text: null, subtype: null, errorCode: "run_timeout", costUsd: 0 }, "run_timeout"],
    ["was not started by Paperclip", { ok: false, text: null, subtype: null, errorCode: "wake_skipped", costUsd: 0 }, "wake_skipped"],
    ["failed", { ok: false, text: null, subtype: "error_during_execution", errorCode: "adapter_failed", costUsd: 0.05 }, "run_failed"],
  ])("maps a run that %s to %s and still records its cost", async (_name, step, kind) => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const t = make([step as RunStep]);
    await expect(t.service.baCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind });
    const [run] = await activities(ctx.company.id, "agent.ba_run");
    expect(run!.details).toMatchObject({ ok: false, kind, costUsd: (step as any).costUsd });
    expect(await outputsOf(caseId)).toHaveLength(0);
    expect(workspaceExists()).toBe(false);
  });

  it("does not run an agent that is missing or not as safe as specified", async () => {
    const none = await seedCompany(false);
    const caseNone = await seedRequest(none);
    const t0 = make();
    await expect(t0.service.baCase(none.company.id, caseNone)).rejects.toMatchObject({ kind: "no_agent" });

    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const spec = baAgentSpec({ workspaceRoot: root });
    const t = make();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["engine", { adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md", engine: "acp" } }, "agent_wrong_engine"],
      ["tools", { adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md", extraArgs: ["--tools", "Read,Grep,Glob,Bash", "--disallowedTools", "Read(//paperclip/instances/**)", "--max-budget-usd", "1"] } }, "agent_tools_not_read_only"],
      ["folder", { adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md", cwd: "/paperclip" } }, "agent_wrong_workspace"],
      ["prompt", { metadata: { ...spec.metadata, devflowPromptHash: "old" } }, "agent_prompt_outdated"],
      ["instructions", { adapterConfig: { ...spec.adapterConfig } }, "agent_no_instructions"],
      ["paused", { status: "paused" }, "agent_not_runnable"],
    ];
    for (const [, patch, kind] of cases) {
      await db.update(agents).set({ adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" }, metadata: spec.metadata, status: "idle" }).where(eq(agents.id, ctx.agentId!));
      await db.update(agents).set(patch as any).where(eq(agents.id, ctx.agentId!));
      await expect(t.service.baCase(ctx.company.id, caseId), kind).rejects.toMatchObject({ kind });
    }
    expect(t.runs).toHaveLength(0); // nothing was run, nothing spent
    expect(t.clones).toHaveLength(0);
    expect(workspaceExists()).toBe(false);
  });

  it("stops before running when a repository cannot be fetched or its token is gone", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const system = await seedSystem(ctx, "portal", { tokenSecretId: randomUUID() }); // the secret is not in the store
    await assign(ctx, caseId, system.id);
    const t = make();
    await expect(t.service.baCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "system_missing_token" });
    tokens.set(system.tokenSecretId!, "ghp_x");
    t.cloneFails("clone_failed");
    await expect(t.service.baCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "clone_failed" });
    t.cloneFails("clone_timeout");
    await expect(t.service.baCase(ctx.company.id, caseId)).rejects.toMatchObject({ kind: "clone_timeout" });
    expect(t.runs).toHaveLength(0);
    expect(workspaceExists()).toBe(false);
  });

  it("writes nothing when the request moved while the agent was working", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const t = make([
      {
        during: async () => {
          const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
          await pipelineService(db).transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "triage", expectedVersion: c!.version, actor: { type: "user", userId: ctx.userId } });
        },
        text: JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] }),
      },
    ]);
    expect(await t.service.baCase(ctx.company.id, caseId)).toBe("stale");
    expect(await outputsOf(caseId)).toHaveLength(0);
    expect(await stageOf(caseId)).toBe("triage");
  });

  it("writes nothing when the request changed (same stage, new version) while the agent was working", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const t = make([
      {
        during: async () => {
          await db.update(pipelineCases).set({ version: sql`${pipelineCases.version} + 1` }).where(eq(pipelineCases.id, caseId));
        },
        text: JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] }),
      },
    ]);
    expect(await t.service.baCase(ctx.company.id, caseId)).toBe("stale");
    expect(await outputsOf(caseId)).toHaveLength(0);
    expect(await stageOf(caseId)).toBe("ba_spec");
  });

  it("does not pass on a request_changes reason from before the spec that was sent back", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    await db.insert(pipelineCaseEvents).values({
      companyId: ctx.company.id, caseId, type: "review_decided", actorType: "user", actorId: ctx.userId,
      payload: { decision: "request_changes", reason: "lý do cũ của Triage" }, createdAt: new Date(Date.now() - 3_600_000),
    });
    const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] });
    await make([{ text: noAreas }]).service.baCase(ctx.company.id, caseId);
    await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.caseId, caseId));
    const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
    await pipelineService(db).transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "ba_spec", expectedVersion: c!.version, actor: { type: "user", userId: ctx.userId } });
    const again = make([{ text: noAreas }]);
    await again.service.baCase(ctx.company.id, caseId);
    expect(again.runs[0]!.request).not.toContain("REVIEWER FEEDBACK");
    expect(again.runs[0]!.request).not.toContain("lý do cũ của Triage");
  });

  it("does nothing for a request that is not in BA Spec, and a second run after success is stale", async () => {
    const ctx = await seedCompany();
    const elsewhere = await seedRequest(ctx, { stage: "triage" });
    const t = make();
    expect(await t.service.baCase(ctx.company.id, elsewhere)).toBe("stale");
    const caseId = await seedRequest(ctx);
    const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] });
    const t2 = make([{ text: noAreas }]);
    expect(await t2.service.baCase(ctx.company.id, caseId)).toBe("proposed");
    expect(await t2.service.baCase(ctx.company.id, caseId)).toBe("stale"); // now in ba_review
    expect(t.runs).toHaveLength(0);
    expect(t2.runs).toHaveLength(1);
  });

  it("gives the agent the reviewer's reason after request_changes, but not a Triage-era one", async () => {
    const ctx = await seedCompany();
    const caseId = await seedRequest(ctx);
    const event = (reason: string, at: Date) =>
      db.insert(pipelineCaseEvents).values({ companyId: ctx.company.id, caseId, type: "review_decided", actorType: "user", actorId: ctx.userId, payload: { decision: "request_changes", reason }, createdAt: at });
    await event("lý do cũ của Triage", new Date(Date.now() - 3_600_000));
    const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] });
    // no earlier BA spec: nothing to answer, so no feedback block even though an old decision exists
    const first = make([{ text: noAreas }]);
    await first.service.baCase(ctx.company.id, caseId);
    expect(first.runs[0]!.request).not.toContain("REVIEWER FEEDBACK");
    // the reviewer sends it back; the proposal is superseded and the case returns to ba_spec
    await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.caseId, caseId));
    await event("thiếu luồng phê duyệt của trưởng phòng", new Date(Date.now() + 1000));
    const [c] = await db.select({ version: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
    await pipelineService(db).transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "ba_spec", expectedVersion: c!.version, actor: { type: "user", userId: ctx.userId } });
    const second = make([{ text: noAreas }]);
    expect(await second.service.baCase(ctx.company.id, caseId)).toBe("proposed");
    const request = second.runs[0]!.request;
    expect(request).toContain("thiếu luồng phê duyệt của trưởng phòng");
    expect(request).not.toContain("lý do cũ của Triage");
    expect(request).toContain(VALID_BA_OUTPUT.summary.slice(0, 20)); // a summary of the spec that was sent back
  });

  it("finds only requests waiting in BA Spec without a live proposal, oldest first, skipping excluded companies", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const early = await seedRequest(a);
    const later = await seedRequest(b);
    const inTriage = await seedRequest(a, { stage: "triage" });
    const proposed = await seedRequest(a);
    await db.insert(drAgentOutputs).values({ companyId: a.company.id, caseId: proposed, stageKey: "ba_spec", promptRole: "ba", promptVersion: "v1", promptHash: "h", data: {}, commentText: "x" });
    const t = make();
    const found = (await t.service.findPending(100)).map((r) => r.caseId);
    expect(found).toContain(early);
    expect(found).toContain(later);
    expect(found).not.toContain(inTriage);
    expect(found).not.toContain(proposed);
    expect(found.indexOf(early)).toBeLessThan(found.indexOf(later));
    expect((await t.service.findPending(100, [b.company.id])).map((r) => r.caseId)).not.toContain(later);
  });

  it("uses the requesting company's own agent", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const caseA = await seedRequest(a);
    const caseB = await seedRequest(b);
    const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] });
    const t = make([{ text: noAreas }, { text: noAreas }]);
    await t.service.baCase(a.company.id, caseA);
    await t.service.baCase(b.company.id, caseB);
    expect(t.runs.map((r) => r.agentId)).toEqual([a.agentId, b.agentId]);
  });

  it("reports companies over the daily spend cap from its own run ledger, once per company", async () => {
    await wipe(); // other tests spent money too: start from nothing
    const ctx = await seedCompany();
    const other = await seedCompany();
    const t = make([], { maxUsdPerDay: 1 });
    expect(await t.service.overBudgetCompanies()).toEqual([]);
    const caseId = await seedRequest(ctx);
    const log = (companyId: string, costUsd: number, action = "agent.ba_run") =>
      db.insert(activityLog).values({ companyId, actorType: "system", actorId: "devflow-ba", action, entityType: "pipeline_case", entityId: caseId, details: { costUsd } });
    await log(ctx.company.id, 0.6);
    await log(other.company.id, 0.9);
    expect(await t.service.overBudgetCompanies()).toEqual([]);
    await log(ctx.company.id, 0.5);
    await log(other.company.id, 5, "agent.ba_failed"); // other actions do not count
    const over = await t.service.overBudgetCompanies();
    expect(over.map((o) => o.companyId)).toEqual([ctx.company.id]);
    expect(over[0]!.usd).toBeCloseTo(1.1);
    await expect(make([], { maxUsdPerDay: 0 }).service.overBudgetCompanies()).resolves.toEqual([]); // 0 means no cap
  });

  // ---- worker ------------------------------------------------------------------------------------------------------
  describe("worker", () => {
    // the worker looks at every waiting request in the database, so each test starts from an empty one
    beforeEach(wipe);

    const worker = (service: ReturnType<typeof baService>, clock: { t: number }, opts = {}) =>
      createBaWorker(db, service, { now: () => clock.t, baseBackoffMs: 1000, maxBackoffMs: 10_000, configRetryMs: 5000, breakerThreshold: 99, ...opts });

    it("processes waiting requests and pauses companies that reached the cap", async () => {
      const ctx = await seedCompany();
      const caseId = await seedRequest(ctx);
      const noAreas = JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] });
      const t = make([{ text: noAreas }]);
      const w = worker(t.service, { t: Date.now() });
      await w.sweep();
      expect(await stageOf(caseId)).toBe("ba_review");
      // a company over the cap is skipped and the pause is noted once
      const capped = await seedCompany();
      const cappedCase = await seedRequest(capped);
      await db.insert(activityLog).values({ companyId: capped.company.id, actorType: "system", actorId: "devflow-ba", action: "agent.ba_run", entityType: "pipeline_case", entityId: cappedCase, details: { costUsd: 9 } });
      const t2 = make([], { maxUsdPerDay: 5 });
      const w2 = worker(t2.service, { t: Date.now() });
      await w2.sweep();
      await w2.sweep();
      expect(await stageOf(cappedCase)).toBe("ba_spec");
      expect(t2.runs.filter((r) => r.caseId === cappedCase)).toHaveLength(0);
      expect(await activities(capped.company.id, "agent.ba_budget_paused")).toHaveLength(1);
    });

    it("backs off after a failure and gives up after three, recording each one without request text", async () => {
      const ctx = await seedCompany();
      const caseId = await seedRequest(ctx);
      const clock = { t: Date.now() };
      const t = make([{ ok: false, text: null, errorCode: "adapter_failed", subtype: "error_during_execution" }, { ok: false, text: null, errorCode: "adapter_failed", subtype: "error_during_execution" }, { ok: false, text: null, errorCode: "adapter_failed", subtype: "error_during_execution" }, {}]);
      const w = worker(t.service, clock);
      const mine = () => t.runs.filter((r) => r.caseId === caseId).length;
      await w.sweep();
      expect(mine()).toBe(1);
      await w.sweep(); // still backing off
      expect(mine()).toBe(1);
      clock.t += 1500;
      await w.sweep();
      expect(mine()).toBe(2);
      clock.t += 3000;
      await w.sweep();
      expect(mine()).toBe(3);
      clock.t += 1_000_000;
      await w.sweep(); // gave up: not tried again
      expect(mine()).toBe(3);
      const failed = await activities(ctx.company.id, "agent.ba_failed");
      const gaveUp = await activities(ctx.company.id, "agent.ba_gave_up");
      expect(failed).toHaveLength(2);
      expect(gaveUp).toHaveLength(1);
      expect(gaveUp[0]!.details).toMatchObject({ kind: "run_failed", attempts: 3 });
      expect(JSON.stringify([...failed, ...gaveUp].map((r) => r.details))).not.toMatch(/Cho requester|Người yêu cầu/);
      expect(await stageOf(caseId)).toBe("ba_spec");
    });

    it("retries a setup problem calmly, never gives up on it, and notes it once", async () => {
      const ctx = await seedCompany(false);
      const caseId = await seedRequest(ctx);
      const clock = { t: Date.now() };
      const t = make();
      const w = worker(t.service, clock);
      for (let i = 0; i < 6; i++) {
        await w.sweep();
        clock.t += 6000;
      }
      expect(await activities(ctx.company.id, "agent.ba_failed")).toHaveLength(1);
      expect(await activities(ctx.company.id, "agent.ba_gave_up")).toHaveLength(0);
      // the agent is set up: the very next retry works
      const spec = baAgentSpec({ workspaceRoot: root });
      await db.insert(agents).values({ companyId: ctx.company.id, name: spec.name, role: "general", adapterType: spec.adapterType, adapterConfig: { ...spec.adapterConfig, instructionsFilePath: "/x/AGENTS.md" }, runtimeConfig: spec.runtimeConfig, metadata: spec.metadata, status: "idle" });
      const t2 = make([{ text: JSON.stringify({ ...VALID_BA_OUTPUT, affectedAreas: [] }) }]);
      await worker(t2.service, clock).sweep();
      expect(await stageOf(caseId)).toBe("ba_review");
    });

    it("opens the breaker after repeated failures and stops the pass", async () => {
      const ctx = await seedCompany();
      const cases = [await seedRequest(ctx), await seedRequest(ctx)];
      const clock = { t: Date.now() };
      const failing = { ok: false, text: null, errorCode: "adapter_failed", subtype: "error_during_execution" } as RunStep;
      const t = make([failing, failing, failing, failing]);
      const w = worker(t.service, clock, { breakerThreshold: 2, breakerCooldownMs: 60_000 });
      await w.sweep();
      const after = t.runs.length;
      await w.sweep(); // paused by the breaker
      expect(t.runs.length).toBe(after);
      expect(cases.length).toBe(2);
    });
  });
});
