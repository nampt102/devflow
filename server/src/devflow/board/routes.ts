import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { reviewAccess } from "../review-access.js";
import { staffViewer } from "../staff.js";

type Row = Record<string, any>;

/** The review page that holds a request waiting at a review stage (the card links there). */
const PAGE_OF_STAGE: Record<string, string> = {
  triage_review: "triage",
  ba_review: "ba-review",
  plan_review: "plan-review",
  code_review: "code-review",
  qa_signoff: "qa-signoff",
};

/**
 * Read-only board of every request of the company by stage (openspec change add-request-board): unfinished requests in full,
 * the latest `doneLimit` finished ones. A review stage means a person is waited on, a working stage an agent. Nothing here
 * changes a stage: decisions stay on the review pages.
 */
export function boardRoutes(db: Db) {
  const router = Router();
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

  router.get("/companies/:companyId/devflow/requests-board", async (req, res) => {
    const companyId = req.params.companyId as string;
    const viewer = staffViewer(req, companyId, "see the requests board");
    const doneLimit = Math.min(Math.max(Math.trunc(Number(req.query.doneLimit)) || 50, 0), 200);

    const [pipe] = await rows(sql`select id from pipelines where company_id = ${companyId} and key = 'dev-request' and archived_at is null limit 1`);
    if (!pipe) {
      res.json({ columns: [], cards: [] });
      return;
    }
    const stages = await rows(sql`select id, key, name, kind, position from pipeline_stages where pipeline_id = ${pipe.id} order by position, id`);

    const cases = await rows(sql`
      with live as (
        select c.id, c.case_key, c.title, c.created_at, c.updated_at, c.stage_id, c.terminal_kind, c.version
        from pipeline_cases c where c.pipeline_id = ${pipe.id} and c.company_id = ${companyId} and c.terminal_kind is null
      ), finished as (
        select c.id, c.case_key, c.title, c.created_at, c.updated_at, c.stage_id, c.terminal_kind, c.version
        from pipeline_cases c where c.pipeline_id = ${pipe.id} and c.company_id = ${companyId} and c.terminal_kind is not null
        order by c.updated_at desc limit ${doneLimit}
      ), picked as (select * from live union all select * from finished)
      select p.*, r.request_number, r.classification, r.priority, r.difficulty, u.name as requester_name,
        coalesce((select e.created_at from pipeline_case_events e where e.case_id = p.id and e.company_id = ${companyId}
                  and e.to_stage_id = p.stage_id and e.type in ('ingested', 'transitioned') order by e.created_at desc limit 1), p.updated_at) as entered_at,
        (select array_agg(s.key order by s.key) from dr_request_systems rs join dr_systems s on s.id = rs.system_id and s.company_id = rs.company_id
          where rs.case_id = p.id and rs.company_id = ${companyId}) as systems
      from picked p
      join dr_requests r on r.case_id = p.id and r.company_id = ${companyId}
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id`);

    // the latest agent problem of each case counts only while no successful run came after it
    const ids = cases.map((c) => c.id as string);
    const failures = ids.length
      ? await rows(sql`
          select distinct on (entity_id) entity_id, action, details, created_at
          from activity_log
          where company_id = ${companyId} and entity_type = 'pipeline_case' and entity_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and action ~ '^agent\\.[a-z]+_(failed|gave_up)$'
            and not exists (
              select 1 from activity_log ok where ok.company_id = ${companyId} and ok.entity_type = 'pipeline_case' and ok.entity_id = activity_log.entity_id
                and ok.action ~ '^agent\\.[a-z]+_run$' and (ok.details->>'ok') = 'true' and ok.created_at > activity_log.created_at)
          order by entity_id, created_at desc`)
      : [];
    const failureOf = new Map(failures.map((f) => [f.entity_id as string, f]));

    // who may decide at each review stage that has a request waiting, asked once per stage
    const decideAt = new Map<string, boolean>();
    for (const s of stages) {
      if (s.kind !== "review") continue;
      const sample = cases.find((c) => c.stage_id === s.id && !c.terminal_kind);
      if (sample) decideAt.set(s.id as string, (await reviewAccess(db, companyId, sample.id as string, viewer)).canDecide);
    }
    const stageById = new Map(stages.map((s) => [s.id as string, s]));

    res.json({
      columns: stages.map((s) => ({ key: s.key, name: s.name, kind: s.kind })),
      cards: cases
        .map((c) => {
          const s = stageById.get(c.stage_id as string)!;
          const f = failureOf.get(c.id as string);
          const live = !c.terminal_kind;
          return {
            caseId: c.id,
            caseKey: c.case_key,
            title: c.title,
            requesterName: c.requester_name,
            createdAt: c.created_at,
            stageKey: s.key,
            stageEnteredAt: c.entered_at,
            classification: c.classification ?? null,
            priority: c.priority ?? null,
            difficulty: c.difficulty ?? null,
            systems: c.systems ?? [],
            waitingFor: !live ? null : s.kind === "review" ? "person" : "agent",
            canDecide: live && s.kind === "review" ? (decideAt.get(s.id as string) ?? false) : false,
            reviewPage: live ? (PAGE_OF_STAGE[s.key as string] ?? null) : null,
            lastFailure: f ? { action: f.action, kind: (f.details as Row | null)?.kind ?? null, at: f.created_at } : null,
            terminal: c.terminal_kind ?? null,
          };
        })
        .sort((a, b) => (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())),
    });
  });

  return router;
}
