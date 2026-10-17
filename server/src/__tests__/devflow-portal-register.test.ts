import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authAccounts, authUsers, companies, createDb, drRequesterInvites, drRequesters } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";
import { errorHandler } from "../middleware/error-handler.js";
import { portalInvites } from "../devflow/portal/invites.js";
import { portalRoutes } from "../devflow/portal/routes.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

// Registration through an invitation (openspec/changes/add-intake-portal, task 3.4).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow portal registration through an invitation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const storageDir = mkdtempSync(join(tmpdir(), "devflow-register-"));
  const storage = createStorageService(createLocalDiskStorageProvider(storageDir));
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(40, "x");
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-register-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
    await tempDb?.cleanup();
    rmSync(storageDir, { recursive: true, force: true });
  });

  type Actor = Express.Request["actor"];
  const anonymous: Actor = { type: "none" };
  const session = (userId: string): Actor => ({ type: "board", source: "session", userId, companyIds: [], memberships: [], isInstanceAdmin: false });

  const closedAuth = () =>
    createBetterAuthInstance(
      db,
      { authBaseUrlMode: "auto", authPublicBaseUrl: undefined, authDisableSignUp: true, deploymentMode: "authenticated", deploymentExposure: "private" } as unknown as Config,
      ["http://localhost:3100"],
    );

  function app(actor: Actor = anonymous, rateLimit?: { max: number; windowMs: number }) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", portalRoutes(db, storage, rateLimit ? { rateLimit } : {}));
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

  async function newInvite(companyId: string) {
    const { token, id } = await portalInvites(db).create(companyId, "staff-user", {});
    return { token, id };
  }

  const body = (over: Record<string, unknown> = {}) => ({
    name: "Nguyễn Văn A",
    email: `${randomUUID()}@example.test`,
    password: `pw-${randomUUID()}`,
    ...over,
  });
  const register = (token: string, payload: Record<string, unknown>, actor: Actor = anonymous) =>
    request(app(actor)).post(`/api/portal/invites/${token}/register`).send(payload);
  const usersWithEmail = async (email: string) =>
    db.select().from(authUsers).where(sql`lower(${authUsers.email}) = ${email.toLowerCase()}`);

  it("creates the account and the requester without a session, and the person can then sign in while sign-up is closed", async () => {
    const company = await seedCompany("Register Co");
    const { token, id } = await newInvite(company.id);
    const auth = closedAuth();
    const credentials = body({ email: "Nguoi.Dung@Example.TEST" });

    // premise: the public door is shut
    await expect(auth.api.signUpEmail({ body: credentials as { name: string; email: string; password: string } })).rejects.toThrow(/sign.?up/i);

    const res = await register(token, credentials);
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe(company.id);

    const [user] = await usersWithEmail("nguoi.dung@example.test");
    expect(user.email).toBe("nguoi.dung@example.test"); // stored lowercase, like better-auth
    expect(user.name).toBe("Nguyễn Văn A");
    expect(user.emailVerified).toBe(false);
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.userId, user.id));
    expect(account.providerId).toBe("credential");
    expect(account.issuer).toBe("local:credential");
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(credentials.password as string);

    const requesters = await db.select().from(drRequesters).where(eq(drRequesters.userId, user.id));
    expect(requesters).toHaveLength(1);
    expect(requesters[0].companyId).toBe(company.id);
    const [invite] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, id));
    expect(invite.acceptedByUserId).toBe(user.id);
    expect(invite.acceptedAt).not.toBeNull();

    // the real sign-in path accepts the password hash we wrote
    const signedIn = await auth.api.signInEmail({ body: { email: "nguoi.dung@example.test", password: credentials.password as string } });
    expect(signedIn.user.id).toBe(user.id);
    expect((await request(app(session(user.id))).get("/api/portal/me")).body.companyId).toBe(company.id);
    // the link cannot be reused by someone else...
    expect((await register(token, body())).status).toBe(410);
    // ...but the portal page accepts it right after registering: the new user gets their own result back
    const accepted = await request(app(session(user.id))).post(`/api/portal/invites/${token}/accept`).send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.requesterId).toBe(requesters[0].id);
  });

  it("answers 409 and leaves the link untouched when the email already has an account", async () => {
    const company = await seedCompany("Existing Email Co");
    const { token, id } = await newInvite(company.id);
    const email = `taken-${randomUUID()}@example.test`;
    const now = new Date();
    await db.insert(authUsers).values({ id: `user-${randomUUID()}`, name: "Có sẵn", email, createdAt: now, updatedAt: now });

    const res = await register(token, body({ email: email.toUpperCase() }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("account_exists");
    expect(await usersWithEmail(email)).toHaveLength(1);
    const [invite] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, id));
    expect(invite.acceptedAt).toBeNull();
    expect(await db.select().from(drRequesters).where(eq(drRequesters.companyId, company.id))).toHaveLength(0);
    // the same link still works for a new email
    expect((await register(token, body())).status).toBe(201);
  });

  it("lets exactly one of three simultaneous registrations win a single link", async () => {
    const company = await seedCompany("Race Register Co");
    const { token } = await newInvite(company.id);
    const attempts = [body(), body(), body()];
    const results = await Promise.all(attempts.map((a) => register(token, a)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 410, 410]);
    const created = await db
      .select()
      .from(authUsers)
      .where(inArray(authUsers.email, attempts.map((a) => (a.email as string).toLowerCase())));
    expect(created).toHaveLength(1); // the losers' accounts were rolled back with their transactions
    expect(await db.select().from(drRequesters).where(eq(drRequesters.companyId, company.id))).toHaveLength(1);
  });

  it("creates a single account when one email registers with two links at the same time", async () => {
    const company = await seedCompany("Same Email Co");
    const [a, b] = [await newInvite(company.id), await newInvite(company.id)];
    const email = `same-${randomUUID()}@example.test`;
    const results = await Promise.all([register(a.token, body({ email })), register(b.token, body({ email }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await usersWithEmail(email)).toHaveLength(1);
  });

  it("refuses unusable links before spending a password hash", async () => {
    const company = await seedCompany("Refuse Register Co");
    let hashes = 0;
    const counting = portalInvites(db, { hashPassword: async (p) => (hashes += 1, `hashed:${p}`) });
    const input = (token: string) => ({ token, name: "X", email: `${randomUUID()}@example.test`, password: "password-123" });

    await expect(counting.register(input("A".repeat(43)))).rejects.toMatchObject({ status: 404 });
    const expired = await newInvite(company.id);
    await db.update(drRequesterInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(drRequesterInvites.id, expired.id));
    await expect(counting.register(input(expired.token))).rejects.toMatchObject({ status: 410 });
    const revoked = await newInvite(company.id);
    await portalInvites(db).revoke(company.id, "staff-user", revoked.id);
    await expect(counting.register(input(revoked.token))).rejects.toMatchObject({ status: 410 });
    const used = await newInvite(company.id);
    expect((await register(used.token, body())).status).toBe(201);
    await expect(counting.register(input(used.token))).rejects.toMatchObject({ status: 410 });
    expect(hashes).toBe(0);

    // wrong shape never reaches the database
    expect((await register("short", body())).status).toBe(404);
  });

  it("rejects invalid input without creating anything or using the link", async () => {
    const company = await seedCompany("Validation Co");
    const { token, id } = await newInvite(company.id);
    const before = (await db.select().from(authUsers)).length;
    for (const bad of [
      { password: "1234567" },
      { password: "x".repeat(129) },
      { email: "not-an-email" },
      { name: "   " },
      { name: "N".repeat(101) },
    ]) {
      expect((await register(token, body(bad))).status, JSON.stringify(Object.keys(bad))).toBe(400);
    }
    expect((await db.select().from(authUsers)).length).toBe(before);
    const [invite] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, id));
    expect(invite.acceptedAt).toBeNull();
  });

  it("limits attempts per client address across register and accept", async () => {
    const limited = app(anonymous, { max: 3, windowMs: 60_000 });
    const unknown = "B".repeat(43);
    for (let i = 0; i < 3; i += 1) {
      expect((await request(limited).post(`/api/portal/invites/${unknown}/register`).send(body())).status).toBe(404);
    }
    expect((await request(limited).post(`/api/portal/invites/${unknown}/register`).send(body())).status).toBe(429);
    expect((await request(limited).post(`/api/portal/invites/${unknown}/accept`).send({})).status).toBe(429);
    // other routes are not limited
    expect((await request(limited).get("/api/portal/me")).status).toBe(401);
  });

  it("does not leak the password or the token into the activity log", async () => {
    const company = await seedCompany("Log Co");
    const { token } = await newInvite(company.id);
    const credentials = body();
    expect((await register(token, credentials)).status).toBe(201);
    const logged = await db.execute(sql`select details::text as d, action from activity_log where company_id = ${company.id}`);
    const text = JSON.stringify(logged);
    expect(text).toContain("portal.invite_registered");
    expect(text).not.toContain(credentials.password as string);
    expect(text).not.toContain(token);
    expect(text).not.toContain((credentials.email as string).toLowerCase());
  });
});
