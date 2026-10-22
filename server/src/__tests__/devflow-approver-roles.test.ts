import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, drMemberRoles, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { pipelineStageApproverSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.js";
import { memberRolesRoutes } from "../devflow/roles/routes.js";
import { approverPatches } from "../../../scripts/devflow/lib/approver-sync.mjs";

// Role approvers (openspec change add-approver-roles): the core check for each approver kind, the role branch,
// and the Roles API. The review services' use of the same check is covered in the three devflow-*-review tests.

describe("approver schema", () => {
  it("accepts role approvers with distinct known roles", () => {
    expect(pipelineStageApproverSchema.safeParse({ kind: "role", roles: ["ba", "tech_lead"] }).success).toBe(true);
    expect(pipelineStageApproverSchema.safeParse({ kind: "role", roles: ["tech_lead"] }).success).toBe(true);
  });

  it("refuses a role approver with no roles, unknown roles or repeated roles", () => {
    for (const bad of [{ kind: "role" }, { kind: "role", roles: [] }, { kind: "role", roles: ["admin"] }, { kind: "role", roles: ["ba", "ba"] }]) {
      expect(pipelineStageApproverSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("keeps the old kinds as they were", () => {
    expect(pipelineStageApproverSchema.safeParse({ kind: "any_human" }).success).toBe(true);
    expect(pipelineStageApproverSchema.safeParse({ kind: "user", id: "u1" }).success).toBe(true);
    expect(pipelineStageApproverSchema.safeParse({ kind: "user" }).success).toBe(false);
    expect(pipelineStageApproverSchema.safeParse({ kind: "agent" }).success).toBe(false);
  });
});

describe("approverPatches (seed script)", () => {
  const definition = [
    { key: "work", kind: "working" },
    { key: "plan_review", kind: "review", config: { approver: { kind: "role", roles: ["tech_lead"] } } },
    { key: "qa_signoff", kind: "review", config: { approver: { kind: "any_human" } } },
  ];
  const live = (approver: unknown) => [
    { id: "s0", key: "work", kind: "working", config: {} },
    { id: "s1", key: "plan_review", kind: "review", config: { approveToStageKey: "dev", requireRejectReason: true, approver } },
    { id: "s2", key: "qa_signoff", kind: "review", config: { approver: { kind: "any_human" } } },
  ];

  it("changes only the approver and copies every other field of the live config", () => {
    const patches = approverPatches(definition, live({ kind: "any_human" }));
    expect(patches).toEqual([
      {
        stageId: "s1",
        key: "plan_review",
        body: { config: { approveToStageKey: "dev", requireRejectReason: true, approver: { kind: "role", roles: ["tech_lead"] } } },
      },
    ]);
  });

  it("does nothing when the stages already match, so a second run changes nothing", () => {
    expect(approverPatches(definition, live({ kind: "role", roles: ["tech_lead"] }))).toEqual([]);
  });

  it("rolls every review stage back to any_human with anyHuman", () => {
    const patches = approverPatches(definition, live({ kind: "role", roles: ["tech_lead"] }), { anyHuman: true });
    expect(patches.map((p) => [p.key, p.body.config.approver])).toEqual([["plan_review", { kind: "any_human" }]]);
  });

  it("brings the code review of an already-seeded pipeline to Tech Lead, from the real definition, and nothing else", () => {
    const real = JSON.parse(readFileSync(new URL("../devflow/dev-request-pipeline.json", import.meta.url), "utf8")).stages as Array<{ key: string; kind: string; config?: { approver?: unknown } }>;
    // a company seeded before add-dev-stage: every other review already has its role, code_review is still any_human
    const seeded = real.map((s, i) => ({
      id: `s${i}`,
      key: s.key,
      kind: s.kind,
      config: s.kind === "review" ? { ...s.config, approveToStageKey: "x", approver: s.key === "code_review" ? { kind: "any_human" } : s.config?.approver } : {},
    }));
    const patches = approverPatches(real, seeded);
    expect(patches.map((p) => [p.key, p.body.config.approver])).toEqual([["code_review", { kind: "role", roles: ["tech_lead"] }]]);
    expect(patches[0]!.body.config.approveToStageKey).toBe("x"); // the rest of the live config is kept
    // and a second run changes nothing
    expect(approverPatches(real, seeded.map((s) => (s.key === "code_review" ? { ...s, config: { ...s.config, approver: { kind: "role", roles: ["tech_lead"] } } } : s)))).toEqual([]);
  });

  it("ignores stages the company does not have", () => {
    expect(approverPatches(definition, [])).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("role approvers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-approver-roles-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const svc = () => pipelineService(db);
  const prefix = () => `R${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}`;
  const user = (userId: string): PipelineActor => ({ type: "user", userId });

  async function seedCompany(approver: Record<string, unknown> = { kind: "role", roles: ["tech_lead"] }) {
    const [company] = await db.insert(companies).values({ name: "Roles Co", issuePrefix: prefix() }).returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company!.id, key: "dev-request", name: "Dev Request" }).returning();
    await db.insert(pipelineStages).values([
      { pipelineId: pipeline!.id, key: "draft", name: "Draft", kind: "working", position: 100 },
      {
        pipelineId: pipeline!.id,
        key: "gate",
        name: "Gate",
        kind: "review",
        position: 200,
        config: { requireApproval: true, approver, approveToStageKey: "done", rejectToStageKey: "cancelled", requestChangesToStageKey: "draft", requireRejectReason: true, requireRequestChangesReason: true },
      },
      { pipelineId: pipeline!.id, key: "done", name: "Done", kind: "done", position: 900 },
      { pipelineId: pipeline!.id, key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
    ]);
    return { company: company!, pipeline: pipeline! };
  }
  type Ctx = Awaited<ReturnType<typeof seedCompany>>;

  let counter = 0;
  /** A case waiting at the gate. */
  async function seedCase(ctx: Ctx) {
    const n = ++counter;
    const { case: created } = await svc().ingestCase({ companyId: ctx.company.id, pipelineId: ctx.pipeline.id, caseKey: `R-${n}`, title: `Case ${n}`, stageKey: "draft", actor: { type: "system" } });
    await svc().transitionCase({ companyId: ctx.company.id, caseId: created.id, toStageKey: "gate", expectedVersion: created.version, actor: { type: "system" } });
    return created.id as string;
  }
  const stageOf = async (caseId: string) =>
    (await db.select({ key: pipelineStages.key }).from(pipelineCases).innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId)).where(eq(pipelineCases.id, caseId)))[0]!.key;
  const versionOf = async (caseId: string) => (await db.select({ v: pipelineCases.version }).from(pipelineCases).where(eq(pipelineCases.id, caseId)))[0]!.v;
  const review = async (ctx: Ctx, caseId: string, actor: PipelineActor) =>
    svc().reviewCase({ companyId: ctx.company.id, caseId, decision: "approve", expectedVersion: await versionOf(caseId), actor });
  const moveOut = async (ctx: Ctx, caseId: string, actor: PipelineActor) =>
    svc().transitionCase({ companyId: ctx.company.id, caseId, toStageKey: "done", expectedVersion: await versionOf(caseId), actor });
  const grant = (companyId: string, userId: string, ...roles: string[]) =>
    db.insert(drMemberRoles).values(roles.map((role) => ({ companyId, userId, role })));
  const membership = (companyId: string, userId: string, membershipRole: string, status = "active") =>
    db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status, membershipRole });
  const rejected = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

  // ---- the role branch ---------------------------------------------------------------------------------------------
  it("lets a person with the required role decide", async () => {
    const ctx = await seedCompany();
    const caseId = await seedCase(ctx);
    await grant(ctx.company.id, "lead-1", "tech_lead");
    await review(ctx, caseId, user("lead-1"));
    expect(await stageOf(caseId)).toBe("done");
  });

  it("refuses a person without the role with 403 review_required, and changes nothing", async () => {
    const ctx = await seedCompany();
    const caseId = await seedCase(ctx);
    const before = await versionOf(caseId);
    await grant(ctx.company.id, "ba-1", "ba"); // wrong role for a tech_lead gate
    for (const who of ["ba-1", "nobody"]) {
      const err = await rejected(review(ctx, caseId, user(who)));
      expect(err).toMatchObject({ status: 403, details: { code: "review_required" } });
    }
    expect(await stageOf(caseId)).toBe("gate");
    expect(await versionOf(caseId)).toBe(before);
  });

  it("accepts any one role of the list, and a person with both roles", async () => {
    const ctx = await seedCompany({ kind: "role", roles: ["ba", "tech_lead"] });
    await grant(ctx.company.id, "ba-2", "ba");
    await grant(ctx.company.id, "lead-2", "tech_lead");
    await grant(ctx.company.id, "both-2", "ba", "tech_lead");
    for (const who of ["ba-2", "lead-2", "both-2"]) {
      const caseId = await seedCase(ctx);
      await review(ctx, caseId, user(who));
      expect(await stageOf(caseId)).toBe("done");
    }
  });

  it("does not carry a role over from another company", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await grant(a.company.id, "lead-3", "tech_lead");
    const caseId = await seedCase(b);
    expect(await rejected(review(b, caseId, user("lead-3")))).toMatchObject({ status: 403 });
    expect(await stageOf(caseId)).toBe("gate");
  });

  it("lets the company owner decide without any role, but not an admin member or an inactive owner", async () => {
    const ctx = await seedCompany();
    await membership(ctx.company.id, "owner-1", "owner");
    await membership(ctx.company.id, "admin-1", "admin");
    await membership(ctx.company.id, "owner-gone", "owner", "removed");
    const caseId = await seedCase(ctx);
    for (const who of ["admin-1", "owner-gone"]) {
      expect(await rejected(review(ctx, caseId, user(who)))).toMatchObject({ status: 403 });
    }
    await review(ctx, caseId, user("owner-1"));
    expect(await stageOf(caseId)).toBe("done");
  });

  it("lets an instance admin decide only when the route says so, and an owner of another company not at all", async () => {
    const ctx = await seedCompany();
    const other = await seedCompany();
    await membership(other.company.id, "owner-elsewhere", "owner");
    const caseId = await seedCase(ctx);
    expect(await rejected(review(ctx, caseId, user("root")))).toMatchObject({ status: 403 }); // core HTTP never sets the flag
    expect(await rejected(review(ctx, caseId, user("owner-elsewhere")))).toMatchObject({ status: 403 });
    await review(ctx, caseId, { type: "user", userId: "root", instanceAdmin: true });
    expect(await stageOf(caseId)).toBe("done");
  });

  it("never lets an agent or the system decide a role stage", async () => {
    const ctx = await seedCompany();
    const caseId = await seedCase(ctx);
    for (const actor of [{ type: "agent", agentId: randomUUID(), runId: randomUUID() }, { type: "system" }] as PipelineActor[]) {
      expect(await rejected(review(ctx, caseId, actor))).toMatchObject({ status: 403, details: { code: "review_required" } });
    }
    expect(await stageOf(caseId)).toBe("gate");
  });

  it("applies to the direct transition out of the stage too, not only to the review call", async () => {
    const ctx = await seedCompany();
    const caseId = await seedCase(ctx);
    await grant(ctx.company.id, "ba-4", "ba");
    expect(await rejected(moveOut(ctx, caseId, user("ba-4")))).toMatchObject({ status: 403, details: { code: "review_required" } });
    expect(await rejected(moveOut(ctx, caseId, user("nobody")))).toMatchObject({ status: 403 });
    expect(await stageOf(caseId)).toBe("gate");
    await grant(ctx.company.id, "lead-4", "tech_lead");
    await moveOut(ctx, caseId, user("lead-4"));
    expect(await stageOf(caseId)).toBe("done");
  });

  it("takes effect for the next decision after roles change", async () => {
    const ctx = await seedCompany();
    const caseId = await seedCase(ctx);
    expect(await rejected(review(ctx, caseId, user("late")))).toMatchObject({ status: 403 });
    await grant(ctx.company.id, "late", "tech_lead");
    await review(ctx, caseId, user("late"));
    expect(await stageOf(caseId)).toBe("done");
    await db.delete(drMemberRoles).where(and(eq(drMemberRoles.companyId, ctx.company.id), eq(drMemberRoles.userId, "late")));
    const next = await seedCase(ctx);
    expect(await rejected(review(ctx, next, user("late")))).toMatchObject({ status: 403 });
  });

  // ---- the old approver kinds behave as before -----------------------------------------------------------------------
  it("any_human: every user passes, agents do not", async () => {
    const ctx = await seedCompany({ kind: "any_human" });
    const a = await seedCase(ctx);
    await review(ctx, a, user("anyone"));
    expect(await stageOf(a)).toBe("done");
    const b = await seedCase(ctx);
    expect(await rejected(review(ctx, b, { type: "agent", agentId: randomUUID(), runId: randomUUID() }))).toMatchObject({ status: 403, details: { code: "review_required" } });
  });

  it("user: only the named user passes", async () => {
    const ctx = await seedCompany({ kind: "user", id: "named" });
    const a = await seedCase(ctx);
    expect(await rejected(review(ctx, a, user("someone-else")))).toMatchObject({ status: 403 });
    await review(ctx, a, user("named"));
    expect(await stageOf(a)).toBe("done");
  });

  it("agent: only the named agent passes", async () => {
    const agentId = randomUUID();
    const ctx = await seedCompany({ kind: "agent", id: agentId });
    await db.insert(agents).values({ id: agentId, companyId: ctx.company.id, name: "Approver bot", role: "general", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, status: "idle" });
    const a = await seedCase(ctx);
    expect(await rejected(review(ctx, a, user("anyone")))).toMatchObject({ status: 403 });
    await review(ctx, a, { type: "agent", agentId, runId: randomUUID() });
    expect(await stageOf(a)).toBe("done");
  });

  // ---- configuration ---------------------------------------------------------------------------------------------------
  it("rejects a stage whose role approver has no valid roles (422) and stores a valid one", async () => {
    const ctx = await seedCompany({ kind: "any_human" });
    const [stage] = await db.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, ctx.pipeline.id), eq(pipelineStages.key, "gate")));
    const config = stage!.config as Record<string, unknown>;
    for (const approver of [{ kind: "role" }, { kind: "role", roles: [] }, { kind: "role", roles: ["admin"] }, { kind: "role", roles: ["ba", "ba"] }, { kind: "whatever" }]) {
      const err = await rejected(svc().updateStage({ companyId: ctx.company.id, pipelineId: ctx.pipeline.id, stageId: stage!.id, patch: { config: { ...config, approver } as any } }));
      expect(err).toMatchObject({ status: 422 });
    }
    await svc().updateStage({ companyId: ctx.company.id, pipelineId: ctx.pipeline.id, stageId: stage!.id, patch: { config: { ...config, approver: { kind: "role", roles: ["ba", "tech_lead"] } } as any } });
    const [saved] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, stage!.id));
    expect((saved!.config as any).approver).toEqual({ kind: "role", roles: ["ba", "tech_lead"] });
  });
});

describeEmbeddedPostgres("member roles API", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-member-roles-api-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];
  const board = (userId: string, companyId: string, membershipRole: string, isInstanceAdmin = false): Actor => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }] as any,
    isInstanceAdmin,
  });
  const app = (actor: Actor) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", memberRolesRoutes(db));
    a.use(errorHandler);
    return a;
  };

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Roles API Co", issuePrefix: `R${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` }).returning();
    const now = new Date();
    const mk = async (label: string, membershipRole: string, status = "active") => {
      const id = `user-${label}-${randomUUID()}`;
      await db.insert(authUsers).values({ id, name: `Người ${label}`, email: `${id}@example.test`, createdAt: now, updatedAt: now });
      await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: id, status, membershipRole });
      return id;
    };
    const owner = await mk("owner", "owner");
    const staff = await mk("staff", "member");
    const target = await mk("target", "member");
    const gone = await mk("gone", "member", "removed");
    const outsiderId = `user-out-${randomUUID()}`;
    await db.insert(authUsers).values({ id: outsiderId, name: "Ngoài công ty", email: `${outsiderId}@example.test`, createdAt: now, updatedAt: now });
    return { companyId: company!.id, owner, staff, target, gone, outsiderId };
  }
  type Ctx = Awaited<ReturnType<typeof seed>>;

  const base = (ctx: Ctx) => `/api/companies/${ctx.companyId}/devflow/member-roles`;
  const put = (ctx: Ctx, actor: Actor, userId: string, body: unknown) => request(app(actor)).put(`${base(ctx)}/${userId}`).send(body as object);
  const rolesOf = async (ctx: Ctx, userId: string) =>
    (await db.select({ role: drMemberRoles.role }).from(drMemberRoles).where(and(eq(drMemberRoles.companyId, ctx.companyId), eq(drMemberRoles.userId, userId)))).map((r) => r.role).sort();
  const auditRows = (ctx: Ctx) => db.select().from(activityLog).where(and(eq(activityLog.companyId, ctx.companyId), eq(activityLog.action, "devflow.roles_changed")));

  it("lets the owner give one person both roles and lists them", async () => {
    const ctx = await seed();
    const res = await put(ctx, board(ctx.owner, ctx.companyId, "owner"), ctx.target, { roles: ["tech_lead", "ba"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: ctx.target, roles: ["ba", "tech_lead"], changed: true });
    const list = await request(app(board(ctx.staff, ctx.companyId, "member"))).get(base(ctx));
    expect(list.status).toBe(200);
    expect(list.body.availableRoles).toEqual(["ba", "tech_lead"]);
    expect(list.body.canManage).toBe(false);
    const row = list.body.items.find((i: any) => i.userId === ctx.target);
    expect(row).toMatchObject({ name: "Người target", roles: ["ba", "tech_lead"], membershipRole: "member", alwaysApproves: false });
    expect(list.body.items.find((i: any) => i.userId === ctx.owner)).toMatchObject({ alwaysApproves: true, roles: [] });
    expect(list.body.items.map((i: any) => i.userId)).not.toContain(ctx.gone); // removed members are not staff
  });

  it("tells the owner and an instance admin they can manage, other staff they cannot", async () => {
    const ctx = await seed();
    expect((await request(app(board(ctx.owner, ctx.companyId, "owner"))).get(base(ctx))).body.canManage).toBe(true);
    expect((await request(app(board("root", ctx.companyId, "member", true))).get(base(ctx))).body.canManage).toBe(true);
    expect((await request(app(board(ctx.staff, ctx.companyId, "admin"))).get(base(ctx))).body.canManage).toBe(false);
  });

  it("replaces the list: removing a role and granting another is one change", async () => {
    const ctx = await seed();
    const owner = board(ctx.owner, ctx.companyId, "owner");
    await put(ctx, owner, ctx.target, { roles: ["ba"] });
    const res = await put(ctx, owner, ctx.target, { roles: ["tech_lead"] });
    expect(res.body.roles).toEqual(["tech_lead"]);
    expect(await rolesOf(ctx, ctx.target)).toEqual(["tech_lead"]);
    expect((await put(ctx, owner, ctx.target, { roles: [] })).body.roles).toEqual([]);
    expect(await rolesOf(ctx, ctx.target)).toEqual([]);
  });

  it("is idempotent: a repeat or a duplicate in the body creates no extra row and no audit row", async () => {
    const ctx = await seed();
    const owner = board(ctx.owner, ctx.companyId, "owner");
    await put(ctx, owner, ctx.target, { roles: ["ba"] });
    const again = await put(ctx, owner, ctx.target, { roles: ["ba", "ba"] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ roles: ["ba"], changed: false });
    expect(await rolesOf(ctx, ctx.target)).toEqual(["ba"]);
    expect(await auditRows(ctx)).toHaveLength(1);
  });

  it("writes an audit row with who, whom and what", async () => {
    const ctx = await seed();
    await put(ctx, board(ctx.owner, ctx.companyId, "owner"), ctx.target, { roles: ["ba", "tech_lead"] });
    await put(ctx, board(ctx.owner, ctx.companyId, "owner"), ctx.target, { roles: ["tech_lead"] });
    const rows = (await auditRows(ctx)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorId: ctx.owner, entityId: ctx.target, details: { targetUserId: ctx.target, before: [], after: ["ba", "tech_lead"], added: ["ba", "tech_lead"], removed: [] } });
    expect(rows[1]!.details).toMatchObject({ before: ["ba", "tech_lead"], after: ["tech_lead"], removed: ["ba"] });
  });

  it("lets an instance admin change roles", async () => {
    const ctx = await seed();
    const res = await put(ctx, board("root", ctx.companyId, "member", true), ctx.target, { roles: ["ba"] });
    expect(res.status).toBe(200);
    expect((await db.select().from(drMemberRoles).where(eq(drMemberRoles.userId, ctx.target)))[0]).toMatchObject({ grantedByUserId: "root" });
  });

  it("refuses everyone but the owner and instance admins with 403 and changes nothing", async () => {
    const ctx = await seed();
    for (const role of ["member", "admin", "viewer"]) {
      const res = await put(ctx, board(ctx.staff, ctx.companyId, role), ctx.staff, { roles: ["tech_lead"] });
      expect(res.status).toBe(403);
    }
    // an agent key and a signed-out caller never reach the service
    const agent = await put(ctx, { type: "agent", agentId: randomUUID(), companyId: ctx.companyId } as any, ctx.target, { roles: ["ba"] });
    expect(agent.status).toBe(403);
    expect((await put(ctx, { type: "none" } as any, ctx.target, { roles: ["ba"] })).status).toBe(401);
    expect(await rolesOf(ctx, ctx.staff)).toEqual([]);
    expect(await auditRows(ctx)).toHaveLength(0);
  });

  it("answers 404 for a company the caller cannot reach, and cannot change another company's people", async () => {
    const a = await seed();
    const b = await seed();
    const ownerOfB = board(b.owner, b.companyId, "owner");
    expect((await put(a, ownerOfB, a.target, { roles: ["ba"] })).status).toBe(404);
    expect((await request(app(ownerOfB)).get(base(a))).status).toBe(404);
    // the owner of B naming a person who belongs to A, on B's own path: that person is not B's member
    const res = await put(b, ownerOfB, a.target, { roles: ["ba"] });
    expect(res.status).toBe(422);
    expect(await rolesOf(a, a.target)).toEqual([]);
  });

  it("refuses roles for someone who is not an active member (422)", async () => {
    const ctx = await seed();
    const owner = board(ctx.owner, ctx.companyId, "owner");
    for (const who of [ctx.outsiderId, ctx.gone, `user-${randomUUID()}`]) {
      const res = await put(ctx, owner, who, { roles: ["ba"] });
      expect(res.status).toBe(422);
      expect(res.body.details?.code ?? res.body.error).toBeTruthy();
    }
    expect(await auditRows(ctx)).toHaveLength(0);
  });

  it("refuses an unknown role with 422 and writes nothing, even next to a valid one", async () => {
    const ctx = await seed();
    const owner = board(ctx.owner, ctx.companyId, "owner");
    await put(ctx, owner, ctx.target, { roles: ["ba"] });
    for (const roles of [["admin"], ["ba", "superuser"], ["BA"]]) {
      expect((await put(ctx, owner, ctx.target, { roles })).status).toBe(422);
    }
    expect(await rolesOf(ctx, ctx.target)).toEqual(["ba"]);
    // the shape itself is checked first
    expect((await put(ctx, owner, ctx.target, { roles: "ba" })).status).toBe(400);
    expect((await put(ctx, owner, ctx.target, { roles: ["ba"], extra: 1 })).status).toBe(400);
  });
});
