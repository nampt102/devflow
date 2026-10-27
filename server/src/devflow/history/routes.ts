import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { staffUser } from "../staff.js";
import { buildHistory, type Raw } from "./build.js";

type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only history of one request for staff (openspec change add-request-history): the case's events, what reviewers changed
 * against the agent, every proposal and agent run with its cost, and the emails sent to the requester. `:caseRef` is the
 * request key (REQ-1) or the case id. Nothing sensitive is returned (see history/build.ts).
 */
export function historyRoutes(db: Db) {
  const router = Router();
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

  router.get("/companies/:companyId/devflow/requests/:caseRef/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    staffUser(req, companyId, "see a request's history");
    const ref = req.params.caseRef as string;

    const [c] = await rows(sql`
      select c.id, c.case_key, c.title, c.created_at, st.key as stage_key, st.name as stage_name,
             r.request_number, r.description, r.business_impact, r.classification, r.priority, r.difficulty, u.name as requester_name,
             (select count(*)::int from dr_attachments a where a.case_id = c.id and a.company_id = c.company_id) as attachments
      from pipeline_cases c
      join pipeline_stages st on st.id = c.stage_id
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      where c.company_id = ${companyId} and (${UUID.test(ref) ? sql`c.id = ${ref}::uuid` : sql`c.case_key = ${ref}`})`);
    if (!c) throw notFound("Request not found");
    const caseId = c.id as string;

    const events = await rows(sql`
      select e.type, e.created_at as at, e.actor_type, u.name as actor_name, fs.name as from_stage, ts.name as to_stage, e.payload
      from pipeline_case_events e
      left join "user" u on u.id = e.actor_user_id
      left join pipeline_stages fs on fs.id = e.from_stage_id
      left join pipeline_stages ts on ts.id = e.to_stage_id
      where e.company_id = ${companyId} and e.case_id = ${caseId}
      order by e.created_at`);
    const overrides = await rows(sql`
      select o.created_at as at, o.field, o.agent_value, o.final_value, o.reason, o.stage_key, u.name as actor_name
      from dr_overrides o left join "user" u on u.id = o.actor_user_id
      where o.company_id = ${companyId} and o.case_id = ${caseId}`);
    const outputs = await rows(sql`
      select created_at as at, stage_key, prompt_role, prompt_version, status, data
      from dr_agent_outputs where company_id = ${companyId} and case_id = ${caseId}`);
    const runs = await rows(sql`
      select created_at as at, action, details
      from activity_log
      where company_id = ${companyId} and entity_type = 'pipeline_case' and entity_id = ${caseId} and action like 'agent.%'`);
    const emails = await rows(sql`
      select created_at as at, subject, status, last_error from dr_email_outbox where company_id = ${companyId} and case_id = ${caseId}`);

    const raw: Raw = {
      events: events.map((e) => ({ type: e.type, at: e.at, actorName: e.actor_name ?? null, actorType: e.actor_type, fromStage: e.from_stage ?? null, toStage: e.to_stage ?? null, payload: e.payload ?? {} })),
      overrides: overrides.map((o) => ({ at: o.at, field: o.field, agentValue: o.agent_value, finalValue: o.final_value, actorName: o.actor_name ?? null, reason: o.reason ?? null, stageKey: o.stage_key })),
      outputs: outputs.map((o) => ({ at: o.at, stageKey: o.stage_key, role: o.prompt_role, promptVersion: o.prompt_version, status: o.status, data: o.data ?? {} })),
      runs: runs.map((r) => ({ at: r.at, action: r.action, details: r.details ?? null })),
      emails: emails.map((m) => ({ at: m.at, subject: m.subject, status: m.status, error: m.last_error ?? null })),
    };
    const built = buildHistory(raw);
    res.json({
      request: {
        caseId,
        caseKey: c.case_key,
        title: c.title,
        requestNumber: c.request_number,
        requesterName: c.requester_name,
        createdAt: c.created_at,
        stageKey: c.stage_key,
        stageName: c.stage_name,
        description: c.description,
        businessImpact: c.business_impact ?? null,
        classification: c.classification ?? null,
        priority: c.priority ?? null,
        difficulty: c.difficulty ?? null,
        attachments: c.attachments,
      },
      ...built,
    });
  });

  return router;
}
