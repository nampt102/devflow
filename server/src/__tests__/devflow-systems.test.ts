import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyMemberships, createDb, drSystems } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { systemsRoutes } from "../devflow/systems/routes.js";
import type { SecretDeps } from "../devflow/systems/service.js";
import { errorHandler } from "../middleware/error-handler.js";

// Systems catalog API (openspec/changes/add-ba-spec-stage, tasks 2.1 and 2.2).
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow systems catalog", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-systems-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = Express.Request["actor"];
  const staff = (companyId: string): Actor => ({
    type: "board",
    source: "session",
    userId: "staff-user",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "member", status: "active" }],
  });
  const noAccess: Actor = { type: "board", source: "session", userId: "other-user", isInstanceAdmin: false, companyIds: [], memberships: [] };
  const agent = (companyId: string): Actor => ({ type: "agent", agentId: randomUUID(), companyId, source: "agent_key" } as Actor);

  // in-memory secrets: the real provider is not under test, what DevFlow asks of it is
  function fakeSecrets() {
    const store = new Map<string, { companyId: string; value: string }>();
    const calls: string[] = [];
    const deps: SecretDeps = {
      async create(companyId, name, value) {
        const id = randomUUID();
        store.set(id, { companyId, value });
        calls.push(`create:${name.startsWith("devflow-system-") ? "named" : name}`);
        return id;
      },
      async rotate(_companyId, id, value) {
        store.get(id)!.value = value;
        calls.push("rotate");
      },
      async remove(id) {
        store.delete(id);
        calls.push("remove");
      },
      async exists(companyId, id) {
        return store.get(id)?.companyId === companyId;
      },
    };
    return { store, calls, deps };
  }

  function app(actor: Actor, secrets?: SecretDeps) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", systemsRoutes(db, secrets));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    return company!;
  }

  const body = (over: Record<string, unknown> = {}) => ({ key: "hr-portal", name: "HR Portal", repoUrl: "https://github.com/acme/hr-portal", ...over });
  const url = (companyId: string, suffix = "") => `/api/companies/${companyId}/devflow/systems${suffix}`;

  it("creates a system with defaults and lists it without any secret information", async () => {
    const company = await seedCompany("Create");
    const s = fakeSecrets();
    const res = await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body({ token: "ghp_secret-value" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: "hr-portal", defaultBranch: "main", docsPath: "docs", active: true, hasToken: true, description: "" });
    expect(JSON.stringify(res.body)).not.toMatch(/ghp_secret-value|tokenSecretId|token_secret_id/);
    expect([...s.store.values()].map((v) => v.value)).toEqual(["ghp_secret-value"]);
    const list = await request(app(staff(company.id), s.deps)).get(url(company.id));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/ghp_secret-value|tokenSecretId|token_secret_id/);
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(logged).toMatchObject({ action: "system.created", actorId: "staff-user" });
    expect(JSON.stringify(logged!.details)).not.toMatch(/ghp_secret-value/);
  });

  it("accepts a public repository without a token and normalises a .git suffix", async () => {
    const company = await seedCompany("Public");
    const s = fakeSecrets();
    const res = await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body({ repoUrl: "https://github.com/acme/hr-portal.git" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ hasToken: false, repoUrl: "https://github.com/acme/hr-portal" });
    expect(s.calls).toEqual([]);
  });

  it("refuses values that must not reach a git command line", async () => {
    const company = await seedCompany("Validation");
    const s = fakeSecrets();
    const post = (over: Record<string, unknown>) => request(app(staff(company.id), s.deps)).post(url(company.id)).send(body(over));
    for (const over of [
      { repoUrl: "http://github.com/acme/hr" },
      { repoUrl: "https://github.com/acme/hr --upload-pack=x" },
      { repoUrl: "https://user:pw@github.com/acme/hr" },
      { repoUrl: "https://gitlab.com/acme/hr" },
      { repoUrl: "file:///etc/passwd" },
      { key: "Bad Key" },
      { key: "-x" },
      { defaultBranch: "--upload-pack=x" },
      { defaultBranch: "-b" },
      { defaultBranch: "a..b" },
      { defaultBranch: "main;rm" },
      { defaultBranch: "x.lock" },
      { docsPath: "../secrets" },
      { docsPath: "/etc" },
      { docsPath: "docs/../../x" },
      { name: "" },
      { unknownField: 1 },
    ]) {
      const res = await post(over);
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    expect(await db.select().from(drSystems).where(eq(drSystems.companyId, company.id))).toHaveLength(0);
    expect(s.calls).toEqual([]);
  });

  it("answers a duplicate key with 409 and removes the secret it had just stored", async () => {
    const company = await seedCompany("Duplicate");
    const s = fakeSecrets();
    expect((await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body())).status).toBe(201);
    const again = await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body({ token: "ghp_second" }));
    expect(again.status).toBe(409);
    expect(s.store.size).toBe(0);
    expect(s.calls).toEqual(["create:named", "remove"]);
  });

  it("updates fields, rotates, adds and removes the token, and switches a system off", async () => {
    const company = await seedCompany("Update");
    const s = fakeSecrets();
    const created = await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body());
    const id = created.body.id as string;
    const patch = (b: Record<string, unknown>) => request(app(staff(company.id), s.deps)).patch(url(company.id, `/${id}`)).send(b);

    const renamed = await patch({ name: "HR", defaultBranch: "develop", docsPath: "docs/business" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "HR", defaultBranch: "develop", docsPath: "docs/business", hasToken: false });

    expect((await patch({ token: "ghp_one" })).body.hasToken).toBe(true);
    expect([...s.store.values()].map((v) => v.value)).toEqual(["ghp_one"]);
    expect((await patch({ token: "ghp_two" })).body.hasToken).toBe(true);
    expect([...s.store.values()].map((v) => v.value)).toEqual(["ghp_two"]); // rotated in place
    expect((await patch({ token: null })).body.hasToken).toBe(false);
    expect(s.store.size).toBe(0);

    const off = await patch({ active: false });
    expect(off.body.active).toBe(false);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).map((r) => r.action).sort();
    expect(actions).toEqual(["system.created", "system.deactivated", "system.updated", "system.updated", "system.updated", "system.updated"]);
    expect((await patch({ repoUrl: "https://github.com/acme/other" })).status).toBe(400); // the repository itself is not editable
    expect((await patch({ key: "other" })).status).toBe(400);
  });

  it("creates a fresh secret when the stored one is gone", async () => {
    const company = await seedCompany("Gone");
    const s = fakeSecrets();
    const created = await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body({ token: "ghp_old" }));
    s.store.clear(); // someone deleted the secret in the Secrets page
    const res = await request(app(staff(company.id), s.deps)).patch(url(company.id, `/${created.body.id}`)).send({ token: "ghp_new" });
    expect(res.status).toBe(200);
    expect([...s.store.values()].map((v) => v.value)).toEqual(["ghp_new"]);
  });

  it("isolates companies: no listing, reading, changing or probing of another company's systems", async () => {
    const a = await seedCompany("Iso A");
    const b = await seedCompany("Iso B");
    const s = fakeSecrets();
    const mine = await request(app(staff(a.id), s.deps)).post(url(a.id)).send(body());
    // same key in another company is fine
    expect((await request(app(staff(b.id), s.deps)).post(url(b.id)).send(body())).status).toBe(201);
    // B's staff cannot reach A's company routes
    expect((await request(app(staff(b.id), s.deps)).get(url(a.id))).status).toBe(404);
    expect((await request(app(staff(b.id), s.deps)).post(url(a.id)).send(body({ key: "x" }))).status).toBe(404);
    // nor A's system through their own company path
    const before = [s.store.size, s.calls.length];
    const cross = await request(app(staff(b.id), s.deps)).patch(url(b.id, `/${mine.body.id}`)).send({ name: "Hijacked" });
    expect(cross.status).toBe(404);
    // ...and a token sent that way must not touch the secret store either (no rotate, no stray secret)
    const crossToken = await request(app(staff(b.id), s.deps)).patch(url(b.id, `/${mine.body.id}`)).send({ token: "ghp_stolen" });
    expect(crossToken.status).toBe(404);
    expect([s.store.size, s.calls.length]).toEqual(before);
    const [still] = await db.select().from(drSystems).where(eq(drSystems.id, mine.body.id));
    expect(still!.name).toBe("HR Portal");
    expect((await request(app(staff(a.id), s.deps)).get(url(a.id))).body.items).toHaveLength(1);
  });

  describe("agent Dev settings (add-dev-stage)", () => {
    const owner = (companyId: string): Actor => ({ ...staff(companyId), userId: "owner-user", memberships: [{ companyId, membershipRole: "owner", status: "active" }] });
    const admin = (companyId: string): Actor => ({ ...staff(companyId), userId: "admin-user", isInstanceAdmin: true });

    async function newSystem(label: string) {
      const company = await seedCompany(label);
      const s = fakeSecrets();
      const created = await request(app(staff(company.id), s.deps)).post(url(company.id)).send(body());
      const patch = (actor: Actor, b: Record<string, unknown>) => request(app(actor, s.deps)).patch(url(company.id, `/${created.body.id}`)).send(b);
      return { company, s, id: created.body.id as string, patch };
    }

    it("is off by default and the settings never expose the write token", async () => {
      const { company, s, patch, id } = await newSystem("Dev defaults");
      const created = await request(app(staff(company.id), s.deps)).get(url(company.id));
      expect(created.body.items[0]).toMatchObject({ devEnabled: false, hasWriteToken: false, testCommand: null, forbiddenPaths: [], allowUnprotected: false });
      const res = await patch(staff(company.id), { writeToken: "ghp_write-secret", testCommand: "cd backend && npm test", forbiddenPaths: ["deploy/**", "*.pem"] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hasWriteToken: true, devEnabled: false, testCommand: "cd backend && npm test", forbiddenPaths: ["deploy/**", "*.pem"] });
      expect(JSON.stringify(res.body)).not.toMatch(/ghp_write-secret|writeTokenSecretId|write_token_secret_id/);
      expect([...s.store.values()].map((v) => v.value)).toEqual(["ghp_write-secret"]);
      const [row] = await db.select().from(drSystems).where(eq(drSystems.id, id));
      expect(row!.tokenSecretId).toBeNull(); // the read token is a different secret
      const logged = (await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).map((r) => JSON.stringify(r.details)).join("");
      expect(logged).not.toMatch(/ghp_write-secret/);
    });

    it("refuses to enable Dev without a write token, and to remove the token while Dev is on", async () => {
      const { company, s, patch } = await newSystem("Dev token");
      expect((await patch(staff(company.id), { devEnabled: true })).status).toBe(422);
      expect((await patch(staff(company.id), { devEnabled: true, writeToken: "ghp_w" })).body.devEnabled).toBe(true);
      expect((await patch(staff(company.id), { writeToken: null })).status).toBe(422);
      expect(s.store.size).toBe(1);
      const off = await patch(staff(company.id), { devEnabled: false, writeToken: null });
      expect(off.body).toMatchObject({ devEnabled: false, hasWriteToken: false });
      expect(s.store.size).toBe(0);
    });

    it("rotates the write token in place and keeps it apart from the read token", async () => {
      const { company, s, patch } = await newSystem("Dev rotate");
      await patch(staff(company.id), { token: "ghp_read" });
      await patch(staff(company.id), { writeToken: "ghp_w1" });
      await patch(staff(company.id), { writeToken: "ghp_w2" });
      expect([...s.store.values()].map((v) => v.value).sort()).toEqual(["ghp_read", "ghp_w2"]);
      await patch(staff(company.id), { token: null }); // dropping the read token leaves the write token
      expect([...s.store.values()].map((v) => v.value)).toEqual(["ghp_w2"]);
    });

    it("lets only the owner or an instance admin allow an unprotected branch", async () => {
      const { company, patch, id } = await newSystem("Dev unprotected");
      await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "owner" });
      expect((await patch(staff(company.id), { allowUnprotected: true })).status).toBe(403);
      const [still] = await db.select().from(drSystems).where(eq(drSystems.id, id));
      expect(still!.allowUnprotected).toBe(false);
      expect((await patch(owner(company.id), { allowUnprotected: true })).body.allowUnprotected).toBe(true);
      expect((await patch(staff(company.id), { allowUnprotected: false })).body.allowUnprotected).toBe(false); // turning it off is for everyone
      expect((await patch(admin(company.id), { allowUnprotected: true })).body.allowUnprotected).toBe(true);
      // an owner of another company does not count
      const other = await seedCompany("Dev unprotected other");
      await db.insert(companyMemberships).values({ companyId: other.id, principalType: "user", principalId: "staff-user", status: "active", membershipRole: "owner" });
      await patch(staff(company.id), { allowUnprotected: false });
      expect((await patch(staff(company.id), { allowUnprotected: true })).status).toBe(403);
    });

    it("validates the command and the forbidden paths", async () => {
      const { company, patch } = await newSystem("Dev validation");
      for (const bad of [
        { testCommand: "" },
        { testCommand: "x".repeat(501) },
        { forbiddenPaths: ["../etc"] },
        { forbiddenPaths: ["/etc/passwd"] },
        { forbiddenPaths: ["a/../b"] },
        { forbiddenPaths: ["a b"] },
        { forbiddenPaths: Array.from({ length: 51 }, (_, i) => `p${i}`) },
        { devEnabled: "yes" },
        { writeToken: "" },
      ]) {
        expect((await patch(staff(company.id), bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      }
      expect((await patch(staff(company.id), { testCommand: null, forbiddenPaths: [] })).status).toBe(200);
    });

    it("does not touch another company's secrets through a cross-company system id", async () => {
      const a = await newSystem("Dev iso A");
      const b = await seedCompany("Dev iso B");
      const before = a.s.calls.length;
      const res = await request(app(staff(b.id), a.s.deps)).patch(url(b.id, `/${a.id}`)).send({ writeToken: "ghp_x", devEnabled: true });
      expect(res.status).toBe(404);
      expect(a.s.calls.length).toBe(before);
    });
  });

  it("is for signed-in staff only", async () => {
    const company = await seedCompany("Auth");
    const s = fakeSecrets();
    expect((await request(app({ type: "none", source: "none" } as Actor, s.deps)).get(url(company.id))).status).toBe(401);
    expect((await request(app(noAccess, s.deps)).get(url(company.id))).status).toBe(404);
    expect((await request(app(agent(company.id), s.deps)).get(url(company.id))).status).toBe(403);
    expect((await request(app(agent(company.id), s.deps)).post(url(company.id)).send(body())).status).toBe(403);
    expect(await db.select().from(drSystems).where(eq(drSystems.companyId, company.id))).toHaveLength(0);
  });
});
