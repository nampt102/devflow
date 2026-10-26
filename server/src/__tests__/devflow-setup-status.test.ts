import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, companies, companyMemberships, createDb, pipelineStages, pipelineTransitions, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setupRoutes } from "../devflow/setup/routes.js";
import { approverPatches as tsPatches, mergedTransitions as tsMerged } from "../devflow/setup/pipeline-sync.js";
import { approverPatches as mjsPatches, mergedTransitions as mjsMerged } from "../../../scripts/devflow/lib/approver-sync.mjs";

// Setup page status (openspec change add-agent-setup-ui): who may see it, what it reports for a new company and for a pipeline
// seeded before QA existed, and that the TypeScript sync equals the script's.

const definition = JSON.parse(readFileSync(new URL("../devflow/dev-request-pipeline.json", import.meta.url), "utf8")) as {
  key: string;
  name: string;
  stages: Array<{ key: string; name: string; kind: string; position: number; config?: Record<string, unknown> }>;
  transitions: Array<{ fromStageKey: string; toStageKey: string; label?: string }>;
};

describe("sync in TypeScript equals the script", () => {
  const live = definition.stages.map((s, i) => ({
    id: `s${i}`,
    key: s.key,
    kind: s.kind,
    config: s.kind === "review" ? { ...s.config, approver: { kind: "any_human" }, requestChangesToStageKey: s.key === "qa_signoff" ? "qa" : undefined } : {},
  }));
  const liveTransitions = definition.transitions
    .filter((t) => !(t.fromStageKey === "qa_signoff" && t.toStageKey === "dev"))
    .map((t) => ({ fromStageId: `s${definition.stages.findIndex((s) => s.key === t.fromStageKey)}`, toStageId: `s${definition.stages.findIndex((s) => s.key === t.toStageKey)}`, label: t.label ?? null }));

  it("gives the same patches and transitions on an out-of-date pipeline", () => {
    expect(tsPatches(definition.stages, live)).toEqual(mjsPatches(definition.stages, live));
    expect(tsPatches(definition.stages, live).length).toBeGreaterThan(0);
    expect(tsMerged(definition.transitions, liveTransitions, live)).toEqual(mjsMerged(definition.transitions, liveTransitions, live));
    expect(tsMerged(definition.transitions, liveTransitions, live)).not.toBeNull();
  });

  it("changes nothing when the pipeline already matches", () => {
    const matching = definition.stages.map((s, i) => ({ id: `s${i}`, key: s.key, kind: s.kind, config: s.config ?? {} }));
    const all = definition.transitions.map((t) => ({ fromStageId: `s${definition.stages.findIndex((s) => s.key === t.fromStageKey)}`, toStageId: `s${definition.stages.findIndex((s) => s.key === t.toStageKey)}`, label: t.label ?? null }));
    expect(tsPatches(definition.stages, matching)).toEqual([]);
    expect(tsMerged(definition.transitions, all, matching)).toBeNull();
  });
});

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("GET devflow/setup-status", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-devflow-setup-status-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];
  const board = (userId: string, companyId: string, membershipRole: string): Actor => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }] as any,
    isInstanceAdmin: false,
  });
  const app = (actor: Actor, runnerReachable = true) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", setupRoutes(db, {}, async () => (runnerReachable ? {} : Promise.reject(new Error("ENOTFOUND")))));
    a.use(errorHandler);
    return a;
  };

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Setup Co", issuePrefix: `S${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` }).returning();
    const now = new Date();
    const mk = async (label: string, membershipRole: string) => {
      const id = `user-${label}-${randomUUID()}`;
      await db.insert(authUsers).values({ id, name: label, email: `${id}@example.test`, createdAt: now, updatedAt: now });
      await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: id, status: "active", membershipRole });
      return id;
    };
    return { companyId: company!.id, owner: await mk("owner", "owner"), staff: await mk("staff", "member") };
  }
  const get = (ctx: Awaited<ReturnType<typeof seed>>, actor: Actor, reachable = true) => request(app(actor, reachable)).get(`/api/companies/${ctx.companyId}/devflow/setup-status`);

  it("refuses a member who is not owner or admin", async () => {
    const ctx = await seed();
    const res = await get(ctx, board(ctx.staff, ctx.companyId, "member"));
    expect(res.status).toBe(403);
  });

  it("reports a new company: no agents, no pipeline, runner without environment", async () => {
    const ctx = await seed();
    const res = await get(ctx, board(ctx.owner, ctx.companyId, "owner"));
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual({ ba: null, plan: null, dev: null, qa: null });
    expect(res.body.pipeline).toMatchObject({ exists: false, id: null, patches: [], transitions: null });
    expect(res.body.pipeline.definition.key).toBe("dev-request");
    expect(res.body.runner.environment).toBe(false);
    expect(res.body.needsAttention).toBe(false);
  });

  it("says when the runner host cannot be resolved", async () => {
    const ctx = await seed();
    const res = await get(ctx, board(ctx.owner, ctx.companyId, "owner"), false);
    expect(res.body.runner.reachable).toBe(false);
  });

  it("shows what a pipeline seeded before QA is missing, and nothing once it matches", async () => {
    const ctx = await seed();
    const [pipe] = await db.insert(pipelines).values({ companyId: ctx.companyId, key: definition.key, name: definition.name }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values(
        definition.stages.map((s) => ({
          pipelineId: pipe!.id,
          key: s.key,
          name: s.name,
          kind: s.kind,
          position: s.position,
          config: s.kind === "review" ? { ...(s.config ?? {}), approver: { kind: "any_human" } } : (s.config ?? {}),
        })),
      )
      .returning();
    const id = (key: string) => stages.find((s) => s.key === key)!.id;
    await db.insert(pipelineTransitions).values(
      definition.transitions
        .filter((t) => !(t.fromStageKey === "qa_signoff" && t.toStageKey === "dev"))
        .map((t) => ({ pipelineId: pipe!.id, fromStageId: id(t.fromStageKey), toStageId: id(t.toStageKey), label: t.label ?? null })),
    );
    const behind = await get(ctx, board(ctx.owner, ctx.companyId, "owner"));
    expect(behind.body.pipeline.exists).toBe(true);
    expect(behind.body.pipeline.patches.length).toBeGreaterThan(0);
    expect(behind.body.pipeline.transitionsMissing).toBe(1);
    expect(behind.body.needsAttention).toBe(true);

    // bring it in line the way the page does: the returned bodies are what it sends
    for (const p of behind.body.pipeline.patches as Array<{ stageId: string; body: { config: Record<string, unknown> } }>) {
      await db.update(pipelineStages).set({ config: p.body.config }).where(eq(pipelineStages.id, p.stageId));
    }
    await db.insert(pipelineTransitions).values({ pipelineId: pipe!.id, fromStageId: id("qa_signoff"), toStageId: id("dev") });
    const synced = await get(ctx, board(ctx.owner, ctx.companyId, "owner"));
    expect(synced.body.pipeline.patches).toEqual([]);
    expect(synced.body.pipeline.transitions).toBeNull();
    expect(synced.body.needsAttention).toBe(false);
  });
});
