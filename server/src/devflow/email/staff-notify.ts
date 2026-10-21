import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { type SendMail } from "./mailer.js";

// Email to staff when new Triage proposals, BA specs or technical plans wait for review (backlog B-01, changes
// add-ba-spec-stage and add-tech-plan-stage).
// Each kind has its own digest and ledger. One digest per company and kind: the first new
// proposal goes out at once, later ones are gathered until `intervalMinutes` have passed since the last digest.
// Recipients: an explicit list (DEVFLOW_STAFF_NOTIFY_EMAILS), otherwise the company's active owners and admins.
// No new table: the ledger is the activity log (`staff.notified` with the newest proposal time it covered).
// The mail names the requests (key and title) and links to the review page; it never contains a request's
// description or the agent's proposal.

export interface StaffNotifyOptions {
  portalBaseUrl: string;
  /** Explicit recipients for every company; empty means "owners and admins of the company". */
  recipients?: string[];
  intervalMinutes?: number;
  /** Proposals older than this are not announced, so a first start never lists old history. */
  maxAgeHours?: number;
  maxListed?: number;
}

type Waiting = { output_id: string; at: Date | string; company_id: string; case_key: string; title: string; prefix: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oneLine = (text: string, max: number) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, max);

export function parseRecipients(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)))];
}

export type DigestKind = "triage" | "ba" | "plan";

/** What each review queue is called in the mail, where its proposals live and how its digests are recorded. */
const KINDS: Record<DigestKind, { stageKey: string; outputStage: string; path: string; notified: string; failed: string; subject: (n: number) => string; intro: (n: number) => string }> = {
  triage: {
    stageKey: "triage_review",
    outputStage: "triage",
    path: "triage",
    notified: "staff.notified",
    failed: "staff.notify_failed",
    subject: (n) => `[DevFlow] ${n} yêu cầu mới chờ duyệt triage`,
    intro: (n) => `Có ${n} yêu cầu mới đang chờ bạn duyệt phân loại:`,
  },
  ba: {
    stageKey: "ba_review",
    outputStage: "ba_spec",
    path: "ba-review",
    notified: "staff.notified_ba",
    failed: "staff.notify_failed_ba",
    subject: (n) => `[DevFlow] ${n} bản spec BA mới chờ duyệt`,
    intro: (n) => `Có ${n} bản spec BA mới đang chờ bạn duyệt:`,
  },
  plan: {
    stageKey: "plan_review",
    outputStage: "tech_plan",
    path: "plan-review",
    notified: "staff.notified_plan",
    failed: "staff.notify_failed_plan",
    subject: (n) => `[DevFlow] ${n} kế hoạch kỹ thuật mới chờ duyệt`,
    intro: (n) => `Có ${n} kế hoạch kỹ thuật mới đang chờ bạn duyệt:`,
  },
};

export function composeStaffDigest(input: { count: number; items: Array<{ key: string; title: string }>; link: string; more: number; kind?: DigestKind }): { subject: string; body: string } {
  const kind = KINDS[input.kind ?? "triage"];
  return {
    subject: kind.subject(input.count),
    body: [
      kind.intro(input.count),
      "",
      ...input.items.map((i) => `- ${i.key}: ${i.title}`),
      ...(input.more > 0 ? [`- ... và ${input.more} yêu cầu khác`] : []),
      "",
      `Mở màn hình duyệt: ${input.link}`,
      "",
      "Đây là thư tự động từ hệ thống DevFlow.",
    ].join("\n"),
  };
}

export function createStaffNotifier(db: Db, send: SendMail, opts: StaffNotifyOptions) {
  const interval = opts.intervalMinutes ?? 5;
  const maxAge = opts.maxAgeHours ?? 24;
  const maxListed = opts.maxListed ?? 20;
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

  async function recipientsFor(companyId: string): Promise<string[]> {
    if (opts.recipients?.length) return opts.recipients;
    const admins = await rows<{ email: string }>(sql`
      select lower(u.email) as email
      from company_memberships m join "user" u on u.id = m.principal_id
      where m.company_id = ${companyId} and m.principal_type = 'user' and m.status = 'active' and m.membership_role in ('owner', 'admin')`);
    return [...new Set(admins.map((a) => a.email).filter((e) => EMAIL.test(e)))];
  }

  /** One pass over all companies for one queue; returns how many digests were sent. */
  async function runKind(kindName: DigestKind): Promise<number> {
    const queue = KINDS[kindName];
    const waiting = await rows<Waiting>(sql`
      select o.id as output_id, o.created_at as at, c.company_id, c.case_key, c.title, co.issue_prefix as prefix
      from dr_agent_outputs o
      join pipeline_cases c on c.id = o.case_id and c.company_id = o.company_id
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${queue.stageKey}
      join companies co on co.id = c.company_id
      where o.status = 'proposed' and o.stage_key = ${queue.outputStage} and c.terminal_kind is null
        and o.created_at > now() - make_interval(hours => ${maxAge})
      order by c.company_id, o.created_at`);
    const byCompany = new Map<string, Waiting[]>();
    for (const w of waiting) byCompany.set(w.company_id, [...(byCompany.get(w.company_id) ?? []), w]);

    let digests = 0;
    for (const [companyId, items] of byCompany) {
      const [ledger] = await rows<{ up_to: string | null; last_at: string | null; failed_at: string | null }>(sql`
        select
          (select max((details->>'upTo')::timestamptz) from activity_log where company_id = ${companyId} and action = ${queue.notified}) as up_to,
          (select max(created_at) from activity_log where company_id = ${companyId} and action = ${queue.notified}) as last_at,
          (select max(created_at) from activity_log where company_id = ${companyId} and action = ${queue.failed}) as failed_at`);
      const upTo = ledger?.up_to ? new Date(ledger.up_to).getTime() : 0;
      const fresh = items.filter((i) => new Date(i.at).getTime() > upTo);
      if (fresh.length === 0) continue;
      const wait = interval * 60_000;
      const recent = (v: string | null) => (v ? Date.now() - new Date(v).getTime() < wait : false);
      if (recent(ledger?.last_at ?? null) || recent(ledger?.failed_at ?? null)) continue; // gather until the interval has passed

      const to = await recipientsFor(companyId);
      if (to.length === 0) {
        logger.warn({ companyId }, "devflow staff notify: no recipients (set DEVFLOW_STAFF_NOTIFY_EMAILS or give the company an admin)");
        continue;
      }
      const shown = fresh.slice(-maxListed).reverse(); // newest first
      const mail = composeStaffDigest({
        count: fresh.length,
        items: shown.map((i) => ({ key: i.case_key, title: oneLine(i.title, 120) })),
        more: fresh.length - shown.length,
        link: `${opts.portalBaseUrl}/${items[0].prefix}/${queue.path}`,
        kind: kindName,
      });
      let delivered = 0;
      let kind = "unknown";
      for (const address of to) {
        try {
          await send({ to: address, subject: mail.subject, text: mail.body });
          delivered += 1;
        } catch (err) {
          kind = (err as { kind?: string }).kind ?? "unknown";
        }
      }
      const newest = new Date(Math.max(...fresh.map((i) => new Date(i.at).getTime()))).toISOString();
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "devflow-email",
        action: delivered > 0 ? queue.notified : queue.failed,
        entityType: "company",
        entityId: companyId,
        details: delivered > 0 ? { count: fresh.length, upTo: newest, recipients: delivered, failedRecipients: to.length - delivered } : { kind, recipients: to.length },
      });
      if (delivered > 0) digests += 1;
    }
    return digests;
  }

  /** One pass over every queue; returns how many digests were sent. */
  async function run(): Promise<number> {
    return (await runKind("triage")) + (await runKind("ba")) + (await runKind("plan"));
  }

  return { run };
}
