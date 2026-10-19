import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  drAgentOutputs,
  drRequesters,
  drRequests,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { createEmailWorker } from "../devflow/email/email-worker.js";
import { startFakeSmtp, type FakeSmtp } from "../devflow/email/fake-smtp.js";
import { createSender, type MailConfig } from "../devflow/email/mailer.js";
import { composeStaffDigest, createStaffNotifier, parseRecipients } from "../devflow/email/staff-notify.js";

// Backlog B-01: digest email to staff when new proposals wait for review.
describe("staff digest helpers", () => {
  it("parses a recipient list: separators, case, duplicates, invalid entries", () => {
    expect(parseRecipients(" A@x.test, b@x.test;a@x.test  not-an-email ,, c@x ")).toEqual(["a@x.test", "b@x.test"]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients("")).toEqual([]);
  });

  it("names the requests and links to the review page, nothing else", () => {
    const m = composeStaffDigest({ count: 3, items: [{ key: "REQ-3", title: "C" }, { key: "REQ-2", title: "B" }], more: 1, link: "https://devflow.example/DEV/triage" });
    expect(m.subject).toBe("[DevFlow] 3 yêu cầu mới chờ duyệt triage");
    expect(m.body).toContain("- REQ-3: C");
    expect(m.body).toContain("- ... và 1 yêu cầu khác");
    expect(m.body).toContain("https://devflow.example/DEV/triage");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow staff digest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let smtp!: FakeSmtp;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-staff-");
    db = createDb(tempDb.connectionString);
    smtp = await startFakeSmtp();
  }, 60_000);

  afterAll(async () => {
    await smtp?.close();
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    smtp.messages.length = 0;
    smtp.dropConnections = false;
  });

  const mailConfig = (): MailConfig => ({ host: "127.0.0.1", port: smtp.port, secure: false, from: "DevFlow <devflow@example.test>", portalBaseUrl: "https://devflow.example", timeoutMs: 3000 });
  const notifier = (opts: Partial<Parameters<typeof createStaffNotifier>[2]> = {}) =>
    createStaffNotifier(db, createSender(mailConfig()), { portalBaseUrl: "https://devflow.example", intervalMinutes: 5, ...opts });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  async function seedCompany() {
    const prefix = `S${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}`;
    const [company] = await db.insert(companies).values({ name: "Staff Co", issuePrefix: prefix }).returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline.id, key: "triage", name: "Triage", kind: "working", position: 100 },
        { pipelineId: pipeline.id, key: "triage_review", name: "Triage Review", kind: "review", position: 150, config: { approveToStageKey: "triage", rejectToStageKey: "triage" } },
        { pipelineId: pipeline.id, key: "ba_review", name: "BA Review", kind: "review", position: 250, config: { approveToStageKey: "triage", rejectToStageKey: "triage" } },
      ])
      .returning();
    const stage = Object.fromEntries(stages.map((s) => [s.key, s.id])) as Record<string, string>;
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "R", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company.id, userId }).returning();
    return { company, pipeline, stage, userId, requester, prefix };
  }

  async function member(companyId: string, role: string, opts: { status?: string; type?: string } = {}) {
    const id = `user-${randomUUID()}`;
    const email = `${id}@staff.test`;
    const now = new Date();
    await db.insert(authUsers).values({ id, name: role, email, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: opts.type ?? "user", principalId: id, status: opts.status ?? "active", membershipRole: role });
    return email;
  }

  let counter = 0;
  async function waiting(ctx: Awaited<ReturnType<typeof seedCompany>>, minutesAgo = 1, title?: string) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: title ?? `Yêu cầu ${n}`,
      stageKey: "triage",
      actor: { type: "user", userId: ctx.userId },
    });
    await db.update(pipelineCases).set({ stageId: ctx.stage.triage_review }).where(eq(pipelineCases.id, created.id));
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "MÔ TẢ-BÍ-MẬT" });
    await db.insert(drAgentOutputs).values({
      companyId: ctx.company.id,
      caseId: created.id,
      stageKey: "triage",
      promptRole: "triage",
      promptVersion: "v3",
      promptHash: "h",
      data: { summary: "ĐỀ-XUẤT-BÍ-MẬT" },
      commentText: "c",
      createdAt: ago(minutesAgo),
    });
    return { id: created.id as string, key: `REQ-${n}` };
  }

  const ledger = (companyId: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "staff.notified")));
  const recipientsOf = () => smtp.messages.flatMap((m) => m.to).sort();

  it("sends one digest to the explicit list, naming the requests and linking to the company's review page", async () => {
    const ctx = await seedCompany();
    const a = await waiting(ctx, 3, "Báo cáo kho");
    const b = await waiting(ctx, 1, "Công nợ\r\nBcc: evil@x.test");
    expect(await notifier({ recipients: ["x@staff.test", "y@staff.test"] }).run()).toBe(1);
    expect(recipientsOf()).toEqual(["x@staff.test", "y@staff.test"]);
    const m = smtp.messages[0];
    expect(m.subject).toBe("[DevFlow] 2 yêu cầu mới chờ duyệt triage");
    expect(m.text).toContain(`- ${b.key}: Công nợ Bcc: evil@x.test`);
    expect(m.text).toContain(`- ${a.key}: Báo cáo kho`);
    expect(m.text.indexOf(b.key)).toBeLessThan(m.text.indexOf(a.key)); // newest first
    expect(m.text).toContain(`https://devflow.example/${ctx.prefix}/triage`);
    expect(m.text).not.toContain("MÔ TẢ-BÍ-MẬT");
    expect(m.text).not.toContain("ĐỀ-XUẤT-BÍ-MẬT");
    const rows = await ledger(ctx.company.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].details)).not.toContain("@");
  });

  /** A request whose BA spec waits for review. */
  async function waitingBa(ctx: Awaited<ReturnType<typeof seedCompany>>, minutesAgo = 1, title?: string) {
    const n = ++counter;
    const { case: created } = await pipelineService(db).ingestCase({
      companyId: ctx.company.id,
      pipelineId: ctx.pipeline.id,
      caseKey: `REQ-${n}`,
      title: title ?? `Yêu cầu ${n}`,
      stageKey: "triage",
      actor: { type: "user", userId: ctx.userId },
    });
    await db.update(pipelineCases).set({ stageId: ctx.stage.ba_review }).where(eq(pipelineCases.id, created.id));
    await db.insert(drRequests).values({ caseId: created.id, companyId: ctx.company.id, requestNumber: n, requesterId: ctx.requester.id, description: "MÔ TẢ-BÍ-MẬT" });
    await db.insert(drAgentOutputs).values({
      companyId: ctx.company.id,
      caseId: created.id,
      stageKey: "ba_spec",
      promptRole: "ba",
      promptVersion: "v1",
      promptHash: "h",
      data: { summary: "SPEC-BÍ-MẬT" },
      commentText: "c",
      createdAt: ago(minutesAgo),
    });
    return { id: created.id as string, key: `REQ-${n}` };
  }

  it("announces BA specs in their own digest with their own ledger, apart from triage proposals", async () => {
    const ctx = await seedCompany();
    const triage = await waiting(ctx, 2, "Báo cáo kho");
    const ba = await waitingBa(ctx, 1, "Công nợ khách hàng");
    const n = notifier({ recipients: ["x@staff.test"] });
    expect(await n.run()).toBe(2);
    expect(smtp.messages.map((m) => m.subject).sort()).toEqual(["[DevFlow] 1 bản spec BA mới chờ duyệt", "[DevFlow] 1 yêu cầu mới chờ duyệt triage"]);
    const baMail = smtp.messages.find((m) => m.subject.includes("spec BA"))!;
    const triageMail = smtp.messages.find((m) => m.subject.includes("triage"))!;
    expect(baMail.text).toContain(`- ${ba.key}: Công nợ khách hàng`);
    expect(baMail.text).not.toContain(triage.key);
    expect(baMail.text).toContain(`https://devflow.example/${ctx.prefix}/ba-review`);
    expect(triageMail.text).toContain(triage.key);
    expect(triageMail.text).not.toContain(ba.key);
    expect(triageMail.text).toContain(`https://devflow.example/${ctx.prefix}/triage`);
    expect(baMail.text).not.toContain("SPEC-BÍ-MẬT");
    expect(baMail.text).not.toContain("MÔ TẢ-BÍ-MẬT");
    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, ctx.company.id))).map((r) => r.action).sort();
    expect(actions).toEqual(["staff.notified", "staff.notified_ba"]);
    // neither repeats; a new spec is announced without repeating the triage mail
    expect(await n.run()).toBe(0);
  });

  it("a failed BA digest is recorded on its own and does not hold back the triage digest", async () => {
    const ctx = await seedCompany();
    const n = notifier({ recipients: ["x@staff.test"], intervalMinutes: 60 });
    await waitingBa(ctx, 1);
    smtp.dropConnections = true;
    expect(await n.run()).toBe(0);
    const actions = async () => (await db.select().from(activityLog).where(eq(activityLog.companyId, ctx.company.id))).map((r) => r.action).sort();
    expect(await actions()).toEqual(["staff.notify_failed_ba"]);
    smtp.dropConnections = false;
    await waiting(ctx, 1);
    expect(await n.run()).toBe(1); // triage goes out; the BA retry waits for its own interval
    expect(smtp.messages.map((m) => m.subject)).toEqual(["[DevFlow] 1 yêu cầu mới chờ duyệt triage"]);
    expect(await actions()).toEqual(["staff.notified", "staff.notify_failed_ba"]);
  });

  it("gathers BA specs on their own interval: a recent triage digest does not hold them back", async () => {
    const ctx = await seedCompany();
    await waiting(ctx, 2);
    const n = notifier({ recipients: ["x@staff.test"], intervalMinutes: 60 });
    expect(await n.run()).toBe(1); // triage digest just went out
    await waitingBa(ctx, 1);
    expect(await n.run()).toBe(1); // the BA spec is not held back by it
    await waitingBa(ctx, 0.1);
    expect(await n.run()).toBe(0); // but a second BA spec inside the BA interval is gathered
    expect(smtp.messages).toHaveLength(2);
  });

  it("does not repeat itself, gathers later proposals until the interval passes, then sends only the new ones", async () => {
    const ctx = await seedCompany();
    await waiting(ctx, 2);
    const n = notifier({ recipients: ["x@staff.test"], intervalMinutes: 60 });
    expect(await n.run()).toBe(1);
    expect(await n.run()).toBe(0); // nothing new
    const later = await waiting(ctx, 0.1);
    expect(await n.run()).toBe(0); // new, but inside the interval
    expect(smtp.messages).toHaveLength(1);
    // the interval passes: age the ledger entry
    await db.execute(
      (await import("drizzle-orm")).sql`update activity_log set created_at = now() - interval '2 hours' where company_id = ${ctx.company.id} and action = 'staff.notified'`,
    );
    expect(await n.run()).toBe(1);
    expect(smtp.messages).toHaveLength(2);
    expect(smtp.messages[1].subject).toBe("[DevFlow] 1 yêu cầu mới chờ duyệt triage");
    expect(smtp.messages[1].text).toContain(later.key);
  });

  it("without a list it tells the company's active owners and admins, nobody else", async () => {
    const ctx = await seedCompany();
    const other = await seedCompany();
    const owner = await member(ctx.company.id, "owner");
    const admin = await member(ctx.company.id, "admin");
    await member(ctx.company.id, "operator");
    await member(ctx.company.id, "viewer");
    await member(ctx.company.id, "admin", { status: "suspended" });
    await member(ctx.company.id, "admin", { type: "agent" });
    await member(other.company.id, "admin");
    await waiting(ctx);
    expect(await notifier().run()).toBe(1);
    expect(recipientsOf()).toEqual([owner, admin].sort());
  });

  it("digests are per company: each lists only its own requests, to its own people", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const adminA = await member(a.company.id, "admin");
    const adminB = await member(b.company.id, "admin");
    const ra = await waiting(a);
    const rb = await waiting(b);
    expect(await notifier().run()).toBe(2);
    const toA = smtp.messages.find((m) => m.to.includes(adminA))!;
    const toB = smtp.messages.find((m) => m.to.includes(adminB))!;
    expect(toA.text).toContain(ra.key);
    expect(toA.text).not.toContain(rb.key);
    expect(toB.text).toContain(rb.key);
    expect(toB.text).not.toContain(ra.key);
  });

  it("ignores old proposals, proposals no longer waiting, and companies with nobody to tell", async () => {
    const ctx = await seedCompany();
    await waiting(ctx, 3 * 24 * 60); // three days old
    expect(await notifier({ recipients: ["x@staff.test"] }).run()).toBe(0);
    const decided = await waiting(ctx, 1);
    await db.update(drAgentOutputs).set({ status: "accepted", decidedAt: new Date(), decidedByUserId: "u" }).where(eq(drAgentOutputs.caseId, decided.id));
    expect(await notifier({ recipients: ["x@staff.test"] }).run()).toBe(0);
    const lonely = await seedCompany();
    await waiting(lonely, 1);
    expect(await notifier().run()).toBe(0); // no admins, no list
    expect(smtp.messages).toHaveLength(0);
  });

  it("a failed send is not recorded as sent and is retried; partial delivery counts as sent", async () => {
    const ctx = await seedCompany();
    const r1 = await waiting(ctx, 1);
    smtp.dropConnections = true;
    const n = notifier({ recipients: ["x@staff.test"], intervalMinutes: 0 });
    expect(await n.run()).toBe(0);
    expect(await ledger(ctx.company.id)).toHaveLength(0);
    const failed = await db.select().from(activityLog).where(and(eq(activityLog.companyId, ctx.company.id), eq(activityLog.action, "staff.notify_failed")));
    expect(failed).toHaveLength(1);
    expect((failed[0].details as any).kind).toBeTruthy();
    smtp.dropConnections = false;
    await n.run();
    expect(await ledger(ctx.company.id)).toHaveLength(1);
    expect(smtp.messages.some((m) => m.text.includes(r1.key))).toBe(true);
    // one rejected recipient out of two still counts as delivered
    const ctx2 = await seedCompany();
    await waiting(ctx2, 1);
    smtp.rejectRcpt.add("bad@staff.test");
    await notifier({ recipients: ["bad@staff.test", "good@staff.test"] }).run();
    expect((await ledger(ctx2.company.id))[0].details).toMatchObject({ recipients: 1, failedRecipients: 1 });
    smtp.rejectRcpt.clear();
  });

  it("a failure waits for the interval before the next try", async () => {
    const ctx = await seedCompany();
    await waiting(ctx, 1);
    smtp.dropConnections = true;
    const n = notifier({ recipients: ["x@staff.test"], intervalMinutes: 60 });
    await n.run();
    smtp.dropConnections = false;
    const before = smtp.connections;
    expect(await n.run()).toBe(0);
    expect(smtp.connections).toBe(before); // did not even try
  });

  it("runs inside the email worker sweep and only one worker sends when two sweep together", async () => {
    const ctx = await seedCompany();
    await waiting(ctx, 1);
    const worker = () =>
      createEmailWorker(db, createSender(mailConfig()), { portalBaseUrl: "https://devflow.example", delaySeconds: 0, staff: { portalBaseUrl: "https://devflow.example", recipients: ["x@staff.test"], intervalMinutes: 5 } });
    const results = await Promise.all([worker().sweep(), worker().sweep()]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(smtp.messages.filter((m) => m.to.includes("x@staff.test"))).toHaveLength(1);
    expect(results.find((r) => r)?.staffDigests).toBe(1);
  });
});
