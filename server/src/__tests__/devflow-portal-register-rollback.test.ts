import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authAccounts, authUsers, companies, createDb, drRequesterInvites, drRequesters } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hashInviteToken, portalInvites } from "../devflow/portal/invites.js";

// The last step of registration (activity log) fails: nothing may be left behind and the link must survive.
vi.mock("../services/activity-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/activity-log.js")>()),
  logActivity: vi.fn(async () => {
    throw new Error("activity log unavailable");
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow portal registration rollback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-register-rollback-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates no user, account or requester and keeps the invitation pending when a later step fails", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Rollback Co", issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const token = "R".repeat(43);
    const [invite] = await db
      .insert(drRequesterInvites)
      .values({ companyId: company.id, tokenHash: hashInviteToken(token), createdByUserId: "staff", expiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    const email = `rollback-${randomUUID()}@example.test`;
    const usersBefore = (await db.select().from(authUsers)).length;
    const accountsBefore = (await db.select().from(authAccounts)).length;

    await expect(
      portalInvites(db).register({ token, name: "Người dùng", email, password: "password-123" }),
    ).rejects.toThrow(/activity log unavailable/);

    expect((await db.select().from(authUsers)).length).toBe(usersBefore);
    expect((await db.select().from(authAccounts)).length).toBe(accountsBefore);
    expect(await db.select().from(authUsers).where(sql`lower(${authUsers.email}) = ${email}`)).toHaveLength(0);
    expect(await db.select().from(drRequesters).where(eq(drRequesters.companyId, company.id))).toHaveLength(0);
    const [after] = await db.select().from(drRequesterInvites).where(eq(drRequesterInvites.id, invite.id));
    expect(after.acceptedAt).toBeNull();
    expect(after.acceptedByUserId).toBeNull();
  });
});
