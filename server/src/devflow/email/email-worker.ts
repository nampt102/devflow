import { eq, sql } from "drizzle-orm";
import { drEmailOutbox, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { statusLabelVi } from "../portal/status-labels.js";
import { composeStatusEmail } from "./compose.js";
import { MailError, type SendMail } from "./mailer.js";

// Status-change emails to requesters (openspec/decisions/0016). Two steps per sweep:
//  1. enqueue: turn new pipeline events of dev-request cases into outbox rows (one row per event);
//  2. deliver: send pending rows, with backoff, and give up after maxAttempts.
// Delivery is at-least-once: a crash between the SMTP "250" and the commit can resend one email.

export interface EmailWorkerOptions {
  portalBaseUrl: string;
  /** Events newer than this are held back, so quick consecutive steps collapse into one email. */
  delaySeconds?: number;
  /** Events older than this are ignored, so enabling email never mails history. */
  maxAgeHours?: number;
  enqueueBatch?: number;
  deliverBatch?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

type EventRow = {
  event_id: string;
  type: string;
  case_id: string;
  company_id: string;
  case_key: string;
  title: string;
  request_number: number;
  requester_id: string;
  deactivated: boolean;
  email: string | null;
  from_key: string | null;
  to_key: string | null;
};

const LOCK_KEY = "dr-email-worker";

export function createEmailWorker(db: Db, send: SendMail, opts: EmailWorkerOptions) {
  const delay = opts.delaySeconds ?? 60;
  const maxAge = opts.maxAgeHours ?? 24;
  const enqueueBatch = opts.enqueueBatch ?? 100;
  const deliverBatch = opts.deliverBatch ?? 10;
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseBackoff = opts.baseBackoffMs ?? 60_000;

  async function enqueue(): Promise<number> {
    const events = (await db.execute(sql`
      select e.id as event_id, e.type, e.case_id, e.company_id, c.case_key, c.title, r.request_number,
             rq.id as requester_id, (rq.deactivated_at is not null) as deactivated, u.email,
             fs.key as from_key, ts.key as to_key
      from pipeline_case_events e
      join pipeline_cases c on c.id = e.case_id and c.company_id = e.company_id
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      left join pipeline_stages ts on ts.id = e.to_stage_id
      left join pipeline_stages fs on fs.id = e.from_stage_id
      where e.type in ('ingested', 'transitioned', 'transition_forced')
        and e.created_at <= now() - make_interval(secs => ${delay})
        and e.created_at > now() - make_interval(hours => ${maxAge})
        and not exists (select 1 from dr_email_outbox o where o.event_id = e.id)
      order by e.created_at, e.id
      limit ${enqueueBatch}`)) as unknown as EventRow[];

    // Only the newest event of a case in this batch can send; earlier ones are recorded as superseded.
    const lastOfCase = new Map<string, string>();
    for (const e of events) lastOfCase.set(e.case_id, e.event_id);

    let queued = 0;
    for (const e of events) {
      const label = statusLabelVi(e.to_key);
      let status: "pending" | "skipped" = "pending";
      let note: string | null = null;
      if (lastOfCase.get(e.case_id) !== e.event_id) [status, note] = ["skipped", "superseded"];
      else if (e.deactivated || !e.email || !e.to_key) [status, note] = ["skipped", "no_recipient"];
      else if (e.type !== "ingested" && statusLabelVi(e.from_key) === label) [status, note] = ["skipped", "same_label"];
      const mail =
        status === "pending"
          ? composeStatusEmail({ requestKey: e.case_key, requestNumber: e.request_number, title: e.title, statusLabel: label, portalBaseUrl: opts.portalBaseUrl })
          : { subject: `[${e.case_key}] (not sent)`, body: "(not sent)" };
      const inserted = await db
        .insert(drEmailOutbox)
        .values({
          companyId: e.company_id,
          caseId: e.case_id,
          eventId: e.event_id,
          requesterId: e.requester_id,
          toEmail: (e.email ?? "").slice(0, 320),
          subject: mail.subject,
          body: mail.body,
          status,
          lastError: note,
        })
        .onConflictDoNothing({ target: drEmailOutbox.eventId })
        .returning({ id: drEmailOutbox.id });
      if (inserted.length && status === "pending") queued += 1;
    }
    return queued;
  }

  async function deliver(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const gaveUp: Array<{ companyId: string; caseId: string; kind: string; attempts: number }> = [];
    await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        select id, company_id, case_id, to_email, subject, body, attempts
        from dr_email_outbox
        where status = 'pending' and next_attempt_at <= now()
        order by created_at
        limit ${deliverBatch}
        for update skip locked`)) as unknown as Array<{ id: string; company_id: string; case_id: string; to_email: string; subject: string; body: string; attempts: number }>;
      for (const row of rows) {
        try {
          await send({ to: row.to_email, subject: row.subject, text: row.body });
          await tx.update(drEmailOutbox).set({ status: "sent", sentAt: new Date(), attempts: row.attempts + 1, lastError: null }).where(eq(drEmailOutbox.id, row.id));
          sent += 1;
        } catch (err) {
          const kind = err instanceof MailError ? err.kind : "unknown";
          const attempts = row.attempts + 1;
          const final = attempts >= maxAttempts;
          await tx
            .update(drEmailOutbox)
            .set({
              attempts,
              lastError: kind,
              status: final ? "failed" : "pending",
              nextAttemptAt: new Date(Date.now() + Math.min(baseBackoff * 2 ** (attempts - 1), 3_600_000)),
            })
            .where(eq(drEmailOutbox.id, row.id));
          failed += 1;
          if (final) gaveUp.push({ companyId: row.company_id, caseId: row.case_id, kind, attempts });
          // The server is unreachable or refuses our login: do not hammer it with the rest of the batch.
          if (kind === "auth" || kind === "connection" || kind === "timeout") break;
        }
      }
    });
    for (const g of gaveUp) {
      await logActivity(db, {
        companyId: g.companyId,
        actorType: "system",
        actorId: "devflow-email",
        action: "email.failed",
        entityType: "pipeline_case",
        entityId: g.caseId,
        details: { kind: g.kind, attempts: g.attempts },
      }).catch((err) => logger.warn({ err }, "devflow email: failure not logged"));
    }
    return { sent, failed };
  }

  /** One pass; at most one server instance runs it at a time. */
  async function sweep(): Promise<{ queued: number; sent: number; failed: number } | null> {
    return db.transaction(async (lockTx) => {
      const [lock] = await lockTx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as ok`);
      if (!lock?.ok) return null;
      const queued = await enqueue();
      return { queued, ...(await deliver()) };
    });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    enqueue,
    deliver,
    sweep,
    start(intervalMs = 15_000, shouldRun: () => boolean = () => true) {
      if (timer) return;
      timer = setInterval(() => {
        if (running || !shouldRun()) return;
        running = true;
        sweep()
          .catch((err) => logger.error({ err }, "devflow email sweep failed"))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
