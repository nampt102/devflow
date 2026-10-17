import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authAccounts, authUsers, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

// Characterization of PAPERCLIP_AUTH_DISABLE_SIGN_UP (openspec/changes/add-intake-portal task 3.3):
// what stays possible when public sign-up is closed, and how an invitation could still create an account.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("better-auth with sign-up closed", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  const config = (authDisableSignUp: boolean) =>
    ({
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      authDisableSignUp,
      deploymentMode: "authenticated",
      deploymentExposure: "private",
    }) as unknown as Config;
  const make = (disabled: boolean) => createBetterAuthInstance(db, config(disabled), ["http://localhost:3100"]);

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(40, "x");
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-auth-signup-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
    await tempDb?.cleanup();
  });

  const body = () => ({ name: "Người dùng", email: `${randomUUID()}@example.test`, password: `pw-${randomUUID()}` });

  it("allows public sign-up when it is open (the current default)", async () => {
    const result = await make(false).api.signUpEmail({ body: body() });
    expect(result.user.id).toBeTruthy();
  });

  it("refuses public sign-up when closed, even for a server-side API call", async () => {
    await expect(make(true).api.signUpEmail({ body: body() })).rejects.toThrow(/sign.?up/i);
  });

  it("still lets an existing user sign in when sign-up is closed", async () => {
    const credentials = body();
    await make(false).api.signUpEmail({ body: credentials });
    const result = await make(true).api.signInEmail({ body: { email: credentials.email, password: credentials.password } });
    expect(result.user.email).toBe(credentials.email);
  });

  it("can still create an account server-side with the internal adapter, so an invitation could register people", async () => {
    const closed = make(true);
    const ctx = await closed.$context;
    const credentials = body();
    const user = await ctx.internalAdapter.createUser({ name: credentials.name, email: credentials.email, emailVerified: false });
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      issuer: "local:credential", // NOT NULL in this fork's account table
      password: await ctx.password.hash(credentials.password),
    });
    // the account created that way can sign in through the normal, closed instance
    const signedIn = await closed.api.signInEmail({ body: { email: credentials.email, password: credentials.password } });
    expect(signedIn.user.id).toBe(user.id);
    expect(await db.select().from(authUsers).where(eq(authUsers.id, user.id))).toHaveLength(1);
    expect((await db.select().from(authAccounts).where(eq(authAccounts.userId, user.id)))[0].issuer).toBe("local:credential");
  });
});
