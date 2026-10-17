import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, authUsers, companies, createDb, drRequesterInvites, drRequesters } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { portalRoutes } from "../devflow/portal/routes.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

// One-time requester invitations (openspec/changes/add-intake-portal, "Requester invitation").
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow portal invitations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const storageDir = mkdtempSync(join(tmpdir(), "devflow-invites-"));
  const storage = createStorageService(createLocalDiskStorageProvider(storageDir));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-invites-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(storageDir, { recursive: true, force: true });
  });

  type Actor = Express.Request["actor"];
  const session = (userId: string): Actor => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [],
    memberships: [],
    isInstanceAdmin: false,
  });
  const staff = (userId: string, companyId: string, role = "operator"): Actor => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
    isInstanceAdmin: false,
  });

  function app(actor: Actor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", portalRoutes(db, storage));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    return company;
  }

  async function seedUser() {
    const id = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id, name: "Người dùng", email: `${id}@example.test`, createdAt: now, updatedAt: now });
    return id;
  }

  async function newInvite(companyId: string, label?: string) {
    const creator = await seedUser();
    const res = await request(app(staff(creator, companyId))).post(`/api/companies/${companyId}/portal/invites`).send({ label });
    expect(res.status).toBe(201);
    return { token: res.body.token as string, id: res.body.id as string, creator };
  }

  const accept = (actor: Actor, token: string) => request(app(actor)).post(`/api/portal/invites/${token}/accept`).send({});

  it("creates a link whose token is shown once and stored only as a hash", async () => {
    const company = await seedCompany("Invite Co");
    const creator = await seedUser();
    const res = await request(app(staff(creator, company.id)))
      .post(`/api/companies/${company.id}/portal/invites`)
      .send({ label: "Phòng kế toán" });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.path).toBe(`/portal/invite/${res.body.token}`);
    expect(res.body.status).toBe("pending");
    const days = (new Date(res.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const rows = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.companyId, company.id));
    expect(JSON.stringify(rows)).not.toContain(res.body.token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await request(app(staff(creator, company.id))).get(`/api/companies/${company.id}/portal/invites`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(new RegExp(`${res.body.token}|tokenHash|token_hash`));
  });

  it("lets only non-viewer members of the company manage invitations", async () => {
    const a = await seedCompany("Manage A");
    const b = await seedCompany("Manage B");
    const url = `/api/companies/${a.id}/portal/invites`;
    const user = await seedUser();
    const cases: Array<[string, Actor, number]> = [
      ["viewer", staff(user, a.id, "viewer"), 403],
      ["member of another company", staff(user, b.id), 403],
      ["signed-in user without membership", session(user), 403],
      ["agent key", { type: "agent", agentId: randomUUID(), companyId: a.id }, 403],
      ["unauthenticated", { type: "none" }, 401],
    ];
    for (const [label, actor, status] of cases) {
      expect((await request(app(actor)).post(url).send({})).status, label).toBe(status);
      expect((await request(app(actor)).get(url)).status, `${label} (list)`).toBe(status);
    }
    expect((await request(app(staff(user, a.id, "admin"))).post(url).send({})).status).toBe(201);
    expect((await request(app({ ...staff(user, a.id), isInstanceAdmin: true })).post(url).send({})).status).toBe(201);
  });

  it("turns the accepting user into a requester of the invite's company", async () => {
    const company = await seedCompany("Accept Co");
    const other = await seedCompany("Accept Other");
    const { token, id } = await newInvite(company.id);
    const invitee = await seedUser();

    // companyId in the body is ignored: the company comes from the invite
    const res = await request(app(session(invitee))).post(`/api/portal/invites/${token}/accept`).send({ companyId: other.id });
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(company.id);

    const rows = await db.select().from(drRequesters).where(eq(drRequesters.userId, invitee));
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(company.id);
    const [invite] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, id));
    expect(invite.acceptedByUserId).toBe(invitee);
    expect(invite.acceptedAt).not.toBeNull();

    const me = await request(app(session(invitee))).get("/api/portal/me");
    expect(me.status).toBe(200);
    expect(me.body.companyId).toBe(company.id);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["portal.invite_created", "portal.invite_accepted"]));
  });

  it("works exactly once, even for two people accepting at the same moment", async () => {
    const company = await seedCompany("Race Co");
    const { token } = await newInvite(company.id);
    const [u1, u2, u3] = [await seedUser(), await seedUser(), await seedUser()];
    const results = await Promise.all([u1, u2, u3].map((u) => accept(session(u), token)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410]);
    expect(await db.select().from(drRequesters).where(eq(drRequesters.companyId, company.id))).toHaveLength(1);
    expect((await accept(session(await seedUser()), token)).status).toBe(410); // later attempt
  });

  it("refuses expired, revoked, unknown, malformed links and anonymous callers", async () => {
    const company = await seedCompany("Refuse Co");
    const user = await seedUser();

    const expired = await newInvite(company.id);
    await db.update(drRequesterInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(drRequesterInvites.id, expired.id));
    expect((await accept(session(user), expired.token)).status).toBe(410);

    const revoked = await newInvite(company.id);
    const revokeUrl = `/api/companies/${company.id}/portal/invites/${revoked.id}/revoke`;
    expect((await request(app(staff(revoked.creator, company.id))).post(revokeUrl)).status).toBe(200);
    expect((await accept(session(user), revoked.token)).status).toBe(410);
    expect((await request(app(staff(revoked.creator, company.id))).post(revokeUrl)).status).toBe(404); // already revoked

    expect((await accept(session(user), "A".repeat(43))).status).toBe(404); // right shape, unknown
    expect((await accept(session(user), "short")).status).toBe(404); // wrong shape
    const fresh = await newInvite(company.id);
    expect((await accept({ type: "none" }, fresh.token)).status).toBe(401);
    expect((await accept({ type: "agent", agentId: randomUUID(), companyId: company.id }, fresh.token)).status).toBe(401);
    expect(await db.select().from(drRequesters).where(eq(drRequesters.userId, user))).toHaveLength(0);
  });

  it("does not consume a link for someone who already has portal access, and reactivates a deactivated requester", async () => {
    const company = await seedCompany("Existing Co");
    const active = await seedUser();
    await db.insert(drRequesters).values({ companyId: company.id, userId: active });
    const first = await newInvite(company.id);
    expect((await accept(session(active), first.token)).status).toBe(409);
    const [stillPending] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, first.id));
    expect(stillPending.acceptedAt).toBeNull();

    const dormant = await seedUser();
    const [row] = await db.insert(drRequesters).values({ companyId: company.id, userId: dormant, deactivatedAt: new Date() }).returning();
    const second = await newInvite(company.id);
    const res = await accept(session(dormant), second.token);
    expect(res.status).toBe(200);
    expect(res.body.requesterId).toBe(row.id);
    const [after] = await db.select().from(drRequesters).where(eq(drRequesters.id, row.id));
    expect(after.deactivatedAt).toBeNull();
  });

  it("does not let another company's staff revoke an invitation", async () => {
    const a = await seedCompany("Revoke A");
    const b = await seedCompany("Revoke B");
    const { id } = await newInvite(a.id);
    const intruder = await seedUser();
    const res = await request(app(staff(intruder, b.id))).post(`/api/companies/${b.id}/portal/invites/${id}/revoke`);
    expect(res.status).toBe(404);
    const [invite] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, id));
    expect(invite.revokedAt).toBeNull();
  });
});
