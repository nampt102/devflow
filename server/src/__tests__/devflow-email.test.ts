import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  createDb,
  drEmailOutbox,
  drRequesters,
  drRequests,
  pipelineCaseEvents,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { composeStatusEmail } from "../devflow/email/compose.js";
import { createEmailWorker } from "../devflow/email/email-worker.js";
import { startFakeSmtp, type FakeSmtp } from "../devflow/email/fake-smtp.js";
import { createSender, loadMailConfig, MailError, type MailConfig } from "../devflow/email/mailer.js";

// Status emails to requesters (step 7b): enqueue rules, delivery, retries, isolation. Real nodemailer
// against a fake SMTP server; no real mail leaves the test.

describe("mail config and composition", () => {
  it("is off without host and from; defaults the port by security", () => {
    expect(loadMailConfig({})).toBeNull();
    expect(loadMailConfig({ DEVFLOW_SMTP_HOST: "smtp.gmail.com" })).toBeNull();
    const base = { DEVFLOW_SMTP_HOST: "smtp.gmail.com", DEVFLOW_SMTP_FROM: "DevFlow <a@b.test>" };
    expect(loadMailConfig(base)).toMatchObject({ port: 587, secure: false, portalBaseUrl: "http://localhost:3100" });
    expect(loadMailConfig({ ...base, DEVFLOW_SMTP_SECURE: "true", DEVFLOW_PORTAL_BASE_URL: "https://devflow.example/" })).toMatchObject({
      port: 465,
      secure: true,
      portalBaseUrl: "https://devflow.example",
    });
  });

  it("writes Vietnamese text with only key, title, status label and link; a title cannot break the subject line", () => {
    const m = composeStatusEmail({
      requestKey: "REQ-7",
      requestNumber: 7,
      title: "Báo cáo\r\nBcc: attacker@evil.test",
      statusLabel: "Đang phát triển",
      portalBaseUrl: "https://devflow.example",
    });
    expect(m.subject).toBe("[REQ-7] Trạng thái yêu cầu: Đang phát triển");
    expect(m.body).toContain('Yêu cầu REQ-7 "Báo cáo Bcc: attacker@evil.test" của bạn vừa chuyển sang trạng thái: Đang phát triển.');
    expect(m.body).toContain("https://devflow.example/portal/requests/7");
    expect(m.body).not.toMatch(/\r/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow status emails", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let smtp!: FakeSmtp;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-email-");
    db = createDb(tempDb.connectionString);
    smtp = await startFakeSmtp();
  }, 60_000);

  afterAll(async () => {
    await smtp?.close();
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    smtp.messages.length = 0;
    smtp.rejectRcpt.clear();
    smtp.failAuth = false;
    smtp.dropConnections = false;
  });

  const mailConfig = (extra: Partial<MailConfig> = {}): MailConfig => ({
    host: "127.0.0.1",
    port: smtp.port,
    secure: false,
    from: "DevFlow <devflow@example.test>",
    portalBaseUrl: "https://devflow.example",
    timeoutMs: 3000,
    ...extra,
  });
  const worker = (opts: Partial<Parameters<typeof createEmailWorker>[2]> = {}, cfg: Partial<MailConfig> = {}) =>
    createEmailWorker(db, createSender(mailConfig(cfg)), { portalBaseUrl: "https://devflow.example", delaySeconds: 0, ...opts });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Mail Co", issuePrefix: `M${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` })
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values(
        ["triage", "triage_review", "ba_spec", "x1", "x2"].map((key, i) => ({
          pipelineId: pipeline.id,
          key,
          name: key,
          kind: key === "triage_review" ? ("review" as const) : ("working" as const),
          position: (i + 1) * 100,
          config: key === "triage_review" ? { approveToStageKey: "triage", rejectToStageKey: "triage" } : {},
        })),
      )
      .returning();
    const stage = Object.fromEntries(stages.map((s) => [s.key, s.id])) as Record<string, string>;
    return { company, pipeline, stage };
  }

  async function seedRequester(companyId: string, opts: { deactivated?: boolean } = {}) {
    const userId = `user-${randomUUID()}`;
    const email = `${userId}@example.test`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Người dùng", email, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId, userId, deactivatedAt: opts.deactivated ? now : null }).returning();
    return { userId, email, requester };
  }

  let counter = 0;
  let seq = 0;
  /** A request: real ingest (creates the "ingested" event), then optional extra events. */
  async function seedRequest(ctx: Awaited<ReturnType<typeof seedCompany>>, who: Awaited<ReturnType<typeof seedRequester>>, title = "Báo cáo tồn kho") {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title,
      stageKey: "triage",
      actor: { type: "user", userId: who.userId },
    });
    await db.insert(drRequests).values({
      caseId: created.id,
      companyId: ctx.company.id,
      requestNumber: n,
      requesterId: who.requester.id,
      description: "Mô tả",
    });
    // make the ingest event old enough to pass the delay, and earlier than any event added by a test
    await db.update(pipelineCaseEvents).set({ createdAt: new Date(Date.now() - 20_000) }).where(eq(pipelineCaseEvents.caseId, created.id));
    return { id: created.id as string, key: `REQ-${n}`, number: n };
  }

  async function addEvent(
    ctx: Awaited<ReturnType<typeof seedCompany>>,
    caseId: string,
    from: string,
    to: string,
    over: { type?: string; createdAt?: Date } = {},
  ) {
    const [e] = await db
      .insert(pipelineCaseEvents)
      .values({
        companyId: ctx.company.id,
        caseId,
        type: over.type ?? "transitioned",
        actorType: "system",
        fromStageId: ctx.stage[from],
        toStageId: ctx.stage[to],
        createdAt: over.createdAt ?? new Date(Date.now() - 10_000 + ++seq),
      })
      .returning();
    return e;
  }

  const outbox = (caseId: string) => db.select().from(drEmailOutbox).where(eq(drEmailOutbox.caseId, caseId)).orderBy(drEmailOutbox.createdAt);

  it("sends one email for a quick sequence of steps, to the requester, and never twice", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r = await seedRequest(ctx, who);
    await addEvent(ctx, r.id, "triage", "triage_review");
    const w = worker();
    const first = await w.sweep();
    expect(first).toMatchObject({ queued: 1, sent: 1, failed: 0 });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].to).toEqual([who.email]);
    expect(smtp.messages[0].subject).toBe(`[${r.key}] Trạng thái yêu cầu: Đang chờ duyệt phân loại`);
    expect(smtp.messages[0].text).toContain(`https://devflow.example/portal/requests/${r.number}`);
    expect(smtp.messages[0].text).toContain("Báo cáo tồn kho");
    const rows = await outbox(r.id);
    expect(rows.map((x) => [x.status, x.lastError])).toEqual(expect.arrayContaining([["sent", null], ["skipped", "superseded"]]));
    // again: nothing new
    expect(await w.sweep()).toMatchObject({ queued: 0, sent: 0 });
    expect(smtp.messages).toHaveLength(1);
    // a later step sends a second email
    await addEvent(ctx, r.id, "triage_review", "ba_spec", { createdAt: new Date(Date.now() - 5000) });
    expect(await w.sweep()).toMatchObject({ queued: 1, sent: 1 });
    expect(smtp.messages[1].subject).toContain("Đang phân tích nghiệp vụ");
  });

  it("does not mail internal steps that keep the same requester-facing label", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r = await seedRequest(ctx, who);
    await addEvent(ctx, r.id, "triage", "x1");
    await worker().sweep();
    smtp.messages.length = 0;
    await addEvent(ctx, r.id, "x1", "x2", { createdAt: new Date(Date.now() - 5000) });
    expect(await worker().sweep()).toMatchObject({ queued: 0, sent: 0 });
    expect(smtp.messages).toHaveLength(0);
    expect((await outbox(r.id)).some((x) => x.status === "skipped" && x.lastError === "same_label")).toBe(true);
  });

  it("holds events back for the delay, ignores old ones, and ignores other event types", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const fresh = await seedRequest(ctx, who);
    expect(await worker({ delaySeconds: 3600 }).sweep()).toMatchObject({ queued: 0 });
    expect(await outbox(fresh.id)).toHaveLength(0);

    const old = await seedRequest(ctx, who);
    await db.update(pipelineCaseEvents).set({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) }).where(eq(pipelineCaseEvents.caseId, old.id));
    expect(await worker({ maxAgeHours: 24 }).sweep()).toMatchObject({ queued: 1 }); // only `fresh` (now past the delay)
    expect(await outbox(old.id)).toHaveLength(0);

    const decided = await seedRequest(ctx, who);
    await db.delete(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, decided.id));
    await addEvent(ctx, decided.id, "triage_review", "ba_spec", { type: "review_decided" });
    await worker().sweep();
    expect(await outbox(decided.id)).toHaveLength(0);
  });

  it("skips a deactivated requester, and each requester only gets their own company's mail", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const off = await seedRequester(a.company.id, { deactivated: true });
    const mineA = await seedRequester(a.company.id);
    const mineB = await seedRequester(b.company.id);
    const ra = await seedRequest(a, mineA);
    const rb = await seedRequest(b, mineB);
    const ro = await seedRequest(a, off);
    await Promise.all([addEvent(a, ra.id, "triage", "ba_spec"), addEvent(b, rb.id, "triage", "ba_spec"), addEvent(a, ro.id, "triage", "ba_spec")]);
    await worker().sweep();
    const recipients = smtp.messages.flatMap((m) => m.to);
    expect(recipients).toEqual(expect.arrayContaining([mineA.email, mineB.email]));
    expect(recipients).not.toContain(off.email);
    const sentA = smtp.messages.find((m) => m.to.includes(mineA.email))!;
    expect(sentA.subject).toContain(ra.key);
    expect(sentA.text).not.toContain(rb.key);
    expect((await outbox(ro.id)).every((x) => x.status === "skipped")).toBe(true);
  });

  it("retries with backoff after a connection failure, then delivers", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r = await seedRequest(ctx, who);
    await addEvent(ctx, r.id, "triage", "ba_spec");
    smtp.dropConnections = true;
    const w = worker({ baseBackoffMs: 60_000 });
    expect(await w.sweep()).toMatchObject({ sent: 0, failed: 1 });
    const [row] = (await outbox(r.id)).filter((x) => x.status === "pending");
    expect(row).toMatchObject({ attempts: 1, lastError: "connection" });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    smtp.dropConnections = false;
    expect(await w.sweep()).toMatchObject({ sent: 0, failed: 0 }); // not due yet
    await db.update(drEmailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(drEmailOutbox.id, row.id));
    expect(await w.sweep()).toMatchObject({ sent: 1 });
    expect(smtp.messages).toHaveLength(1);
  });

  it("gives up after maxAttempts, records the kind only, and logs it without the mail text", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r = await seedRequest(ctx, who, "SECRET-TITLE-XYZ");
    await addEvent(ctx, r.id, "triage", "ba_spec");
    smtp.rejectRcpt.add(who.email.toLowerCase());
    const w = worker({ maxAttempts: 2, baseBackoffMs: 1 });
    await w.sweep();
    await db.update(drEmailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(and(eq(drEmailOutbox.caseId, r.id), eq(drEmailOutbox.status, "pending")));
    await w.sweep();
    const failed = (await outbox(r.id)).find((x) => x.status === "failed")!;
    expect(failed).toMatchObject({ attempts: 2, lastError: "rejected" });
    expect(failed.lastError).not.toMatch(/no such user/i);
    const logs = await db.select().from(activityLog).where(and(eq(activityLog.entityId, r.id), eq(activityLog.action, "email.failed")));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0].details)).not.toContain("SECRET-TITLE");
    expect(JSON.stringify(logs[0].details)).not.toContain(who.email);
    await w.sweep();
    expect(smtp.messages).toHaveLength(0);
  });

  it("stops the batch at the first login failure instead of hammering the server", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r1 = await seedRequest(ctx, who);
    const r2 = await seedRequest(ctx, who);
    await Promise.all([addEvent(ctx, r1.id, "triage", "ba_spec"), addEvent(ctx, r2.id, "triage", "ba_spec")]);
    smtp.failAuth = true;
    const w = worker({}, { user: "bot", pass: "wrong" });
    const before = smtp.connections;
    const res = await w.sweep();
    expect(res).toMatchObject({ sent: 0, failed: 1 });
    expect(smtp.connections - before).toBe(1);
    const pending = [...(await outbox(r1.id)), ...(await outbox(r2.id))].filter((x) => x.status === "pending");
    expect(pending.some((x) => x.lastError === "auth")).toBe(true);
    smtp.failAuth = false;
  });

  it("authenticates with the configured user", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r = await seedRequest(ctx, who);
    await addEvent(ctx, r.id, "triage", "ba_spec");
    await worker({}, { user: "bot@example.test", pass: "app-password" }).sweep();
    expect(smtp.messages.at(-1)?.authUser).toBe("bot@example.test");
  });

  it("two workers sweeping at once send exactly one email; a held lock means no work", async () => {
    const ctx = await seedCompany();
    const who = await seedRequester(ctx.company.id);
    const r = await seedRequest(ctx, who);
    await addEvent(ctx, r.id, "triage", "ba_spec");
    const results = await Promise.all([worker().sweep(), worker().sweep()]);
    expect(results.filter((x) => x !== null)).toHaveLength(1);
    expect(smtp.messages.filter((m) => m.to.includes(who.email))).toHaveLength(1);

    let held: unknown = "unset";
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dr-email-worker'))`);
      held = await worker().sweep();
    });
    expect(held).toBeNull();
  });

  it("MailError carries the kind", () => {
    expect(new MailError("auth").kind).toBe("auth");
  });
});
