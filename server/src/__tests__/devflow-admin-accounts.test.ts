import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, authAccounts, authSessions, authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { adminAccountRoutes, adminAccounts } from "../devflow/admin-accounts.js";
import { errorHandler } from "../middleware/error-handler.js";

// Instance admin account tools (openspec/changes/add-intake-portal, task 3.5, ADR 0012).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow instance admin accounts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(40, "x");
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-admin-accounts-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];
  const admin: Actor = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true, companyIds: [], memberships: [] };
  const staff = (companyId: string, role = "admin"): Actor => ({
    type: "board",
    source: "session",
    userId: "staff-user",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  });

  const closedAuth = () =>
    createBetterAuthInstance(
      db,
      { authBaseUrlMode: "auto", authPublicBaseUrl: undefined, authDisableSignUp: true, deploymentMode: "authenticated", deploymentExposure: "private" } as unknown as Config,
      ["http://localhost:3100"],
    );

  function app(actor: Actor = admin) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", adminAccountRoutes(db));
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

  const payload = (over: Record<string, unknown> = {}) => ({ name: "Nhân viên Mới", email: `${randomUUID()}@example.test`, ...over });
  const create = (body: Record<string, unknown>, actor: Actor = admin) => request(app(actor)).post("/api/admin/users").send(body);
  const reset = (userId: string, body: Record<string, unknown> = {}, actor: Actor = admin) =>
    request(app(actor)).post(`/api/admin/users/${userId}/reset-password`).send(body);
  const usersWithEmail = async (email: string) =>
    db.select().from(authUsers).where(sql`lower(${authUsers.email}) = ${email.toLowerCase()}`);

  it("lists a company's users for the access page: instance admins only, scoped to the company, no secrets", async () => {
    const a = await seedCompany("List A");
    const b = await seedCompany("List B");
    const inA = await create(payload({ name: "Bình", companyIds: [a.id] }));
    const inB = await create(payload({ name: "An", companyIds: [b.id] }));
    const both = await create(payload({ name: "Cường", companyIds: [a.id, b.id] }));
    // an agent membership shares the table but is not a person
    await db.insert(companyMemberships).values({ companyId: a.id, principalType: "agent", principalId: inA.body.user.id + "-agent", status: "active", membershipRole: "member" });
    const res = await request(app()).get(`/api/admin/users?companyId=${a.id}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.items.map((u: any) => u.name)).toEqual(["Bình", "Cường"]); // ordered by name, company A only
    expect(res.body.items.map((u: any) => u.id)).toEqual([inA.body.user.id, both.body.user.id]);
    expect(res.body.items[0]).toEqual({ id: inA.body.user.id, name: "Bình", email: inA.body.user.email, membershipRole: "operator", status: "active", hasPassword: true });
    expect(JSON.stringify(res.body)).not.toMatch(/password"\s*:\s*"/i);
    expect(JSON.stringify(res.body)).not.toContain(inB.body.user.email);
    expect((await request(app()).get(`/api/admin/users?companyId=${randomUUID()}`)).body.items).toEqual([]);
    expect((await request(app()).get("/api/admin/users")).status).toBe(400);
    expect((await request(app()).get("/api/admin/users?companyId=not-a-uuid")).status).toBe(400);
    expect((await request(app(staff(a.id))).get(`/api/admin/users?companyId=${a.id}`)).status).toBe(403);
    expect((await request(app({ type: "none" } as Actor)).get(`/api/admin/users?companyId=${a.id}`)).status).toBeGreaterThanOrEqual(401);
  });

  it("is limited to instance admins", async () => {
    const company = await seedCompany("Roles Co");
    const target = await create(payload());
    expect(target.status).toBe(201);
    const cases: Array<[string, Actor]> = [
      ["company admin", staff(company.id, "admin")],
      ["company operator", staff(company.id, "operator")],
      ["viewer", staff(company.id, "viewer")],
      ["agent key", { type: "agent", agentId: randomUUID(), companyId: company.id }],
      ["unauthenticated", { type: "none" }],
    ];
    for (const [label, actor] of cases) {
      const a = await create(payload(), actor);
      expect([401, 403], `${label} create`).toContain(a.status);
      const b = await reset(target.body.user.id, {}, actor);
      expect([401, 403], `${label} reset`).toContain(b.status);
    }
  });

  it("creates an account with a generated password, returned once, that signs in while sign-up is closed", async () => {
    const auth = closedAuth();
    const input = payload({ email: "Nhan.Vien@Example.TEST" });
    await expect(auth.api.signUpEmail({ body: { ...input, password: "x".repeat(12) } as { name: string; email: string; password: string } })).rejects.toThrow(/sign.?up/i);

    const res = await create(input);
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(res.body.user.email).toBe("nhan.vien@example.test");
    expect(res.body.companyIds).toEqual([]);

    const [user] = await usersWithEmail("nhan.vien@example.test");
    expect(user.emailVerified).toBe(false);
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.userId, user.id));
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(res.body.password);
    const signedIn = await auth.api.signInEmail({ body: { email: "nhan.vien@example.test", password: res.body.password } });
    expect(signedIn.user.id).toBe(user.id);
  });

  it("accepts a supplied password without echoing it, and enforces the length bounds", async () => {
    const auth = closedAuth();
    const input = payload();
    const password = `pw-${randomUUID()}`;
    const res = await create({ ...input, password });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("password");
    expect(JSON.stringify(res.body)).not.toContain(password);
    expect((await auth.api.signInEmail({ body: { email: input.email as string, password } })).user.id).toBe(res.body.user.id);

    for (const bad of [{ password: "1234567" }, { password: "x".repeat(129) }, { email: "nope" }, { name: "  " }, { companyIds: ["not-a-uuid"] }]) {
      expect((await create(payload(bad))).status, JSON.stringify(Object.keys(bad))).toBe(400);
    }
  });

  it("answers 409 for an existing email (any letter case) and creates one account when two calls race", async () => {
    const input = payload();
    expect((await create(input)).status).toBe(201);
    const again = await create({ ...input, email: (input.email as string).toUpperCase() });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("account_exists");
    expect(await usersWithEmail(input.email as string)).toHaveLength(1);

    const email = `race-${randomUUID()}@example.test`;
    const results = await Promise.all([create(payload({ email })), create(payload({ email }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await usersWithEmail(email)).toHaveLength(1);
  });

  it("grants company access in the same step and records it per company, without secrets", async () => {
    const [a, b] = [await seedCompany("Grant A"), await seedCompany("Grant B")];
    const input = payload();
    const res = await create({ ...input, companyIds: [a.id, b.id, a.id] });
    expect(res.status).toBe(201);
    expect([...res.body.companyIds].sort()).toEqual([a.id, b.id].sort());
    const rows = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, res.body.user.id));
    expect(rows.map((r) => r.companyId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.status === "active" && r.membershipRole === "operator")).toBe(true);

    const logged = await db.select().from(activityLog).where(inArray(activityLog.companyId, [a.id, b.id]));
    expect(logged.filter((l) => l.action === "admin.user_created")).toHaveLength(2);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(res.body.password);
    expect(text).not.toContain((input.email as string).toLowerCase());
  });

  it("creates nothing when a company does not exist or granting access fails", async () => {
    const company = await seedCompany("Atomic Co");
    const email = `atomic-${randomUUID()}@example.test`;
    expect((await create(payload({ email, companyIds: [company.id, randomUUID()] }))).status).toBe(404);
    expect(await usersWithEmail(email)).toHaveLength(0);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, company.id))).toHaveLength(0);

    const failing = adminAccounts(db, {
      hashPassword: async (p) => `hashed:${p}`,
      grantCompanyAccess: async () => {
        throw new Error("grant failed");
      },
    });
    await expect(failing.createUser("admin-user", { name: "X", email, companyIds: [company.id] })).rejects.toThrow(/grant failed/);
    expect(await usersWithEmail(email)).toHaveLength(0); // the account insert was rolled back with the failed grant
  });

  it("resets a password and signs the person out everywhere", async () => {
    const auth = closedAuth();
    const input = payload();
    const made = await create(input);
    const userId = made.body.user.id as string;
    await auth.api.signInEmail({ body: { email: input.email as string, password: made.body.password } });
    await auth.api.signInEmail({ body: { email: input.email as string, password: made.body.password } });
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(2);

    const res = await reset(userId);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.sessionsRevoked).toBe(2);
    expect(res.body.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(res.body.password).not.toBe(made.body.password);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, userId))).toHaveLength(0);
    await expect(auth.api.signInEmail({ body: { email: input.email as string, password: made.body.password } })).rejects.toThrow();
    expect((await auth.api.signInEmail({ body: { email: input.email as string, password: res.body.password } })).user.id).toBe(userId);

    const chosen = `chosen-${randomUUID()}`;
    const second = await reset(userId, { password: chosen });
    expect(second.body).not.toHaveProperty("password");
    expect((await auth.api.signInEmail({ body: { email: input.email as string, password: chosen } })).user.id).toBe(userId);
  });

  it("refuses to reset an unknown user, one without a password, or with a weak password", async () => {
    expect((await reset("no-such-user")).status).toBe(404);
    const now = new Date();
    const oauthOnly = `oauth-${randomUUID()}`;
    await db.insert(authUsers).values({ id: oauthOnly, name: "OAuth", email: `${oauthOnly}@example.test`, createdAt: now, updatedAt: now });
    const res = await reset(oauthOnly);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("no_credential_account");
    const made = await create(payload());
    expect((await reset(made.body.user.id, { password: "short" })).status).toBe(400);
  });
});
