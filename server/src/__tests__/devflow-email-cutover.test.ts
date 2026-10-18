import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, companies, createDb, drEmailOutbox, drRequesters, drRequests, pipelineCaseEvents, pipelineStages, pipelines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pipelineService } from "../services/pipelines.js";
import { createEmailWorker } from "../devflow/email/email-worker.js";
import { startFakeSmtp, type FakeSmtp } from "../devflow/email/fake-smtp.js";
import { createSender } from "../devflow/email/mailer.js";

// Backlog B-22: the first time email runs on an instance, existing history is recorded as skipped, not mailed.
// Own database: the rule depends on the outbox being empty.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("devflow email first start", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let smtp!: FakeSmtp;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-cutover-");
    db = createDb(tempDb.connectionString);
    smtp = await startFakeSmtp();
  }, 60_000);

  afterAll(async () => {
    await smtp?.close();
    await tempDb?.cleanup();
  });

  it("skips history on the first sweep, then mails only what happens afterwards", async () => {
    const [company] = await db.insert(companies).values({ name: "Cutover Co", issuePrefix: `C${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` }).returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "dev-request", name: "Dev Request" }).returning();
    const stages = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline.id, key: "triage", name: "Triage", kind: "working", position: 100 },
        { pipelineId: pipeline.id, key: "ba_spec", name: "BA", kind: "working", position: 200 },
      ])
      .returning();
    const stage = Object.fromEntries(stages.map((s) => [s.key, s.id])) as Record<string, string>;
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "R", email: "someone@devflow.test", createdAt: now, updatedAt: now });
    const [requester] = await db.insert(drRequesters).values({ companyId: company.id, userId }).returning();

    // history: three requests with events from yesterday, to a fake address
    const history = [];
    for (let n = 1; n <= 3; n++) {
      const { case: c } = await pipelineService(db).ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: `REQ-${n}`, title: `Cũ ${n}`, stageKey: "triage", actor: { type: "user", userId } });
      await db.insert(drRequests).values({ caseId: c.id, companyId: company.id, requestNumber: n, requesterId: requester.id, description: "d" });
      await db.update(pipelineCaseEvents).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(pipelineCaseEvents.caseId, c.id));
      history.push(c.id as string);
    }

    const worker = () => createEmailWorker(db, createSender({ host: "127.0.0.1", port: smtp.port, secure: false, from: "d@example.test", portalBaseUrl: "https://x.test", timeoutMs: 3000 }), { portalBaseUrl: "https://x.test", delaySeconds: 0, enqueueBatch: 2 });
    const first = await worker().sweep();
    expect(first).toMatchObject({ queued: 0, sent: 0 });
    expect(smtp.messages).toHaveLength(0);
    const rows = await db.select().from(drEmailOutbox);
    expect(rows.length).toBe(3); // every history event recorded, across batches of 2
    expect(rows.every((r) => r.status === "skipped" && r.lastError === "before_email_enabled")).toBe(true);

    // something new afterwards is mailed normally (a new worker instance: the rule only applies while the outbox is empty)
    await db.insert(pipelineCaseEvents).values({ companyId: company.id, caseId: history[0], type: "transitioned", actorType: "system", fromStageId: stage.triage, toStageId: stage.ba_spec, createdAt: new Date(Date.now() - 10_000) });
    const second = await worker().sweep();
    expect(second).toMatchObject({ queued: 1, sent: 1 });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].to).toEqual(["someone@devflow.test"]);
  });
});
