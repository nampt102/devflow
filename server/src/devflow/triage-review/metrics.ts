import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Triage quality and flow numbers (step 9, openspec/decisions/0018). Read-only: everything is derived from
// dr_agent_outputs, dr_overrides, pipeline_case_events, activity_log and cost_events, so there is no new schema.
// The override rate is the main quality measure: the share of approved proposals the reviewer had to correct.

type Row = Record<string, any>;
const APPROVE_FIELDS = ["classification", "priority", "difficulty", "requiresHuman", "requiresHumanReasons"] as const;
const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function triageMetricsService(db: Db) {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

  async function metrics(companyId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const sinceIso = since.toISOString();

    // Approved proposals in the window, by prompt version.
    const approved = await rows(sql`
      select prompt_version, count(*)::int as total, count(*) filter (where status = 'overridden')::int as overridden
      from dr_agent_outputs
      where company_id = ${companyId} and stage_key = 'triage' and status in ('accepted', 'overridden') and decided_at >= ${sinceIso}::timestamptz
      group by prompt_version order by prompt_version`);
    const approvedTotal = approved.reduce((n, r) => n + r.total, 0);
    const approvedOverridden = approved.reduce((n, r) => n + r.overridden, 0);

    // One row per corrected field.
    const fieldRows = await rows(sql`
      select ov.field, count(*)::int as n
      from dr_overrides ov join dr_agent_outputs o on o.id = ov.output_id and o.company_id = ov.company_id
      where ov.company_id = ${companyId} and ov.stage_key = 'triage' and o.status in ('accepted', 'overridden') and o.decided_at >= ${sinceIso}::timestamptz
      group by ov.field`);
    const fieldCount = new Map(fieldRows.map((r) => [r.field as string, r.n as number]));

    // Most common corrections (what the agent said -> what the reviewer chose).
    const pairs = await rows(sql`
      select ov.field, ov.agent_value #>> '{}' as agent_value, ov.final_value #>> '{}' as final_value, count(*)::int as n
      from dr_overrides ov join dr_agent_outputs o on o.id = ov.output_id and o.company_id = ov.company_id
      where ov.company_id = ${companyId} and ov.stage_key = 'triage' and ov.field in ('classification', 'priority', 'difficulty')
        and o.status in ('accepted', 'overridden') and o.decided_at >= ${sinceIso}::timestamptz
      group by 1, 2, 3 order by n desc, 1, 2, 3 limit 10`);

    // Decisions from the review events (the core records one per decision).
    const decisions = await rows(sql`
      select e.payload->>'decision' as decision, count(*)::int as n
      from pipeline_case_events e join pipeline_stages fs on fs.id = e.from_stage_id and fs.key = 'triage_review'
      where e.company_id = ${companyId} and e.type = 'review_decided' and e.created_at >= ${sinceIso}::timestamptz
      group by 1`);
    const decisionCount = new Map(decisions.map((r) => [r.decision as string, r.n as number]));

    // Duplicates: what the agent named versus what reviewers did.
    const [dup] = await rows(sql`
      select count(*) filter (where jsonb_array_length(coalesce(o.data->'duplicateCandidates', '[]'::jsonb)) > 0)::int as named,
             count(*) filter (where exists (select 1 from dr_overrides ov where ov.output_id = o.id and ov.field = 'duplicateOf' and ov.final_value is not null))::int as added,
             count(*) filter (where r.duplicate_of_case_id is not null)::int as closed_as_duplicate
      from dr_agent_outputs o join dr_requests r on r.case_id = o.case_id and r.company_id = o.company_id
      where o.company_id = ${companyId} and o.stage_key = 'triage' and o.decided_at >= ${sinceIso}::timestamptz`);

    // Flow: time to the first proposal, and time a proposal waits for and gets a decision.
    const [timing] = await rows(sql`
      with first_output as (
        select distinct on (o.case_id) o.case_id, o.created_at, c.created_at as case_created
        from dr_agent_outputs o join pipeline_cases c on c.id = o.case_id and c.company_id = o.company_id
        where o.company_id = ${companyId} and o.stage_key = 'triage' and o.created_at >= ${sinceIso}::timestamptz
        order by o.case_id, o.created_at
      ), decided as (
        select o.created_at, o.decided_at, c.created_at as case_created
        from dr_agent_outputs o join pipeline_cases c on c.id = o.case_id and c.company_id = o.company_id
        where o.company_id = ${companyId} and o.stage_key = 'triage' and o.status in ('accepted', 'overridden') and o.decided_at >= ${sinceIso}::timestamptz
      )
      select
        (select percentile_cont(0.5) within group (order by extract(epoch from created_at - case_created)) from first_output) as proposal_p50,
        (select percentile_cont(0.9) within group (order by extract(epoch from created_at - case_created)) from first_output) as proposal_p90,
        (select percentile_cont(0.5) within group (order by extract(epoch from decided_at - created_at)) from decided) as review_p50,
        (select percentile_cont(0.9) within group (order by extract(epoch from decided_at - created_at)) from decided) as review_p90,
        (select percentile_cont(0.5) within group (order by extract(epoch from decided_at - case_created)) from decided) as total_p50`);

    const [queue] = await rows(sql`
      select count(*)::int as waiting, min(o.created_at) as oldest
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = 'triage_review'
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = 'triage' and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null`);

    // Agent health: failures from the activity log, tokens from the cost events (no prices exist for them yet).
    const health = await rows(sql`
      select action, count(*)::int as n from activity_log
      where company_id = ${companyId} and created_at >= ${sinceIso}::timestamptz and action in ('agent.triage_proposed', 'agent.triage_failed', 'agent.triage_gave_up', 'agent.embed_failed', 'email.failed', 'agent.triage_budget_paused')
      group by action`);
    const healthCount = new Map(health.map((r) => [r.action as string, r.n as number]));
    // The latest problems, so an operator sees which request and what kind (never the request text).
    const failures = await rows(sql`
      select a.action, a.created_at, a.details->>'kind' as kind, c.case_key
      from activity_log a left join pipeline_cases c on c.id::text = a.entity_id and c.company_id = a.company_id
      where a.company_id = ${companyId} and a.created_at >= ${sinceIso}::timestamptz
        and a.action in ('agent.triage_failed', 'agent.triage_gave_up', 'agent.embed_failed', 'email.failed', 'agent.triage_budget_paused')
      order by a.created_at desc, a.id desc limit 10`);
    const [tokens] = await rows(sql`
      select coalesce(sum(input_tokens), 0)::bigint as input_tokens, coalesce(sum(output_tokens), 0)::bigint as output_tokens, count(*)::int as calls
      from cost_events where company_id = ${companyId} and billing_code in ('devflow:triage', 'devflow:embed') and occurred_at >= ${sinceIso}::timestamptz`);

    return {
      windowDays: days,
      since: since.toISOString(),
      approved: {
        total: approvedTotal,
        overridden: approvedOverridden,
        overrideRate: rate(approvedOverridden, approvedTotal),
        byPromptVersion: approved.map((r) => ({ promptVersion: r.prompt_version as string, total: r.total as number, overridden: r.overridden as number, overrideRate: rate(r.overridden, r.total) })),
      },
      fields: APPROVE_FIELDS.map((field) => ({ field, overrides: fieldCount.get(field) ?? 0, rate: rate(fieldCount.get(field) ?? 0, approvedTotal) })),
      commonCorrections: pairs.map((r) => ({ field: r.field as string, agentValue: r.agent_value as string | null, finalValue: r.final_value as string | null, count: r.n as number })),
      decisions: {
        approve: decisionCount.get("approve") ?? 0,
        reject: decisionCount.get("reject") ?? 0,
        requestChanges: decisionCount.get("request_changes") ?? 0,
      },
      duplicates: { namedByAgent: dup?.named ?? 0, addedByReviewer: dup?.added ?? 0, closedAsDuplicate: dup?.closed_as_duplicate ?? 0 },
      flow: {
        secondsToProposal: { p50: num(timing?.proposal_p50), p90: num(timing?.proposal_p90) },
        secondsInReview: { p50: num(timing?.review_p50), p90: num(timing?.review_p90) },
        secondsToApproval: { p50: num(timing?.total_p50) },
      },
      queue: { waiting: queue?.waiting ?? 0, oldestSince: queue?.oldest ? new Date(queue.oldest).toISOString() : null },
      recentFailures: failures.map((f) => ({
        action: f.action as string,
        kind: (f.kind as string | null) ?? null,
        caseKey: (f.case_key as string | null) ?? null,
        at: new Date(f.created_at).toISOString(),
      })),
      agent: {
        proposed: healthCount.get("agent.triage_proposed") ?? 0,
        failed: healthCount.get("agent.triage_failed") ?? 0,
        gaveUp: healthCount.get("agent.triage_gave_up") ?? 0,
        embedFailed: healthCount.get("agent.embed_failed") ?? 0,
        emailFailed: healthCount.get("email.failed") ?? 0,
        budgetPaused: healthCount.get("agent.triage_budget_paused") ?? 0,
        calls: tokens?.calls ?? 0,
        inputTokens: Number(tokens?.input_tokens ?? 0),
        outputTokens: Number(tokens?.output_tokens ?? 0),
      },
    };
  }

  return { metrics };
}
