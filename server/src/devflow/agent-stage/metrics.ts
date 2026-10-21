import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { StageRole } from "./agent.js";

// Quality, cost and flow numbers of a stage agent (BA spec, Tech Plan). Read-only, no new schema: derived from
// dr_agent_outputs, dr_overrides and DevFlow's own run ledger in activity_log (`agent.<role>_run`, one row per agent
// run with its cost). The override rate is the main quality measure: the share of approved proposals a reviewer had
// to correct.

type Row = Record<string, any>;
const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function stageMetricsService(db: Db, stage: { role: StageRole; stageKey: string; reviewStageKey: string }) {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];
  const { stageKey, reviewStageKey } = stage;
  const act = (what: string) => `agent.${stage.role}_${what}`;

  async function metrics(companyId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const sinceIso = since.toISOString();

    const approved = await rows(sql`
      select prompt_version, count(*)::int as total, count(*) filter (where status = 'overridden')::int as overridden
      from dr_agent_outputs
      where company_id = ${companyId} and stage_key = ${stageKey} and status in ('accepted', 'overridden') and decided_at >= ${sinceIso}::timestamptz
      group by prompt_version order by prompt_version`);
    const approvedTotal = approved.reduce((n, r) => n + r.total, 0);
    const approvedOverridden = approved.reduce((n, r) => n + r.overridden, 0);

    const fieldRows = await rows(sql`
      select ov.field, count(*)::int as n
      from dr_overrides ov join dr_agent_outputs o on o.id = ov.output_id and o.company_id = ov.company_id
      where ov.company_id = ${companyId} and ov.stage_key = ${stageKey} and o.status in ('accepted', 'overridden') and o.decided_at >= ${sinceIso}::timestamptz
      group by ov.field order by n desc, ov.field`);

    const decisions = await rows(sql`
      select e.payload->>'decision' as decision, count(*)::int as n
      from pipeline_case_events e join pipeline_stages fs on fs.id = e.from_stage_id and fs.key = ${reviewStageKey}
      where e.company_id = ${companyId} and e.type = 'review_decided' and e.created_at >= ${sinceIso}::timestamptz
      group by 1`);
    const decisionCount = new Map(decisions.map((r) => [r.decision as string, r.n as number]));

    const [timing] = await rows(sql`
      select
        percentile_cont(0.5) within group (order by extract(epoch from decided_at - created_at)) as review_p50,
        percentile_cont(0.9) within group (order by extract(epoch from decided_at - created_at)) as review_p90
      from dr_agent_outputs
      where company_id = ${companyId} and stage_key = ${stageKey} and status in ('accepted', 'overridden') and decided_at >= ${sinceIso}::timestamptz`);

    const [queue] = await rows(sql`
      select count(*)::int as waiting, min(o.created_at) as oldest
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${reviewStageKey}
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${stageKey} and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null`);

    // Agent runs and what they cost, from the run ledger (a failed run costs money too).
    const [runs] = await rows(sql`
      select count(*)::int as runs,
             count(*) filter (where (details->>'ok')::boolean is not true)::int as failed_runs,
             coalesce(sum((details->>'costUsd')::numeric), 0) as usd,
             coalesce(sum((details->>'inputTokens')::numeric), 0)::bigint as input_tokens,
             coalesce(sum((details->>'outputTokens')::numeric), 0)::bigint as output_tokens
      from activity_log where company_id = ${companyId} and action = ${act("run")} and created_at >= ${sinceIso}::timestamptz`);
    const healthActions = [act("proposed"), act("failed"), act("gave_up"), act("budget_paused")];
    const health = await rows(sql`
      select action, count(*)::int as n from activity_log
      where company_id = ${companyId} and created_at >= ${sinceIso}::timestamptz and action in (${sql.join(healthActions.map((a) => sql`${a}`), sql`, `)})
      group by action`);
    const healthCount = new Map(health.map((r) => [r.action as string, r.n as number]));
    // The latest problems: which request and what kind, never the request text or the agent's words.
    const problemActions = [act("failed"), act("gave_up"), act("budget_paused")];
    const failures = await rows(sql`
      select a.action, a.created_at, a.details->>'kind' as kind, c.case_key
      from activity_log a left join pipeline_cases c on c.id::text = a.entity_id and c.company_id = a.company_id
      where a.company_id = ${companyId} and a.created_at >= ${sinceIso}::timestamptz
        and a.action in (${sql.join(problemActions.map((a) => sql`${a}`), sql`, `)})
      order by a.created_at desc, a.id desc limit 10`);

    const usd = Number(runs?.usd ?? 0);
    return {
      windowDays: days,
      since: since.toISOString(),
      approved: {
        total: approvedTotal,
        overridden: approvedOverridden,
        overrideRate: rate(approvedOverridden, approvedTotal),
        byPromptVersion: approved.map((r) => ({ promptVersion: r.prompt_version as string, total: r.total as number, overridden: r.overridden as number, overrideRate: rate(r.overridden, r.total) })),
      },
      fields: fieldRows.map((r) => ({ field: r.field as string, overrides: r.n as number, rate: rate(r.n, approvedTotal) })),
      decisions: { approve: decisionCount.get("approve") ?? 0, reject: decisionCount.get("reject") ?? 0, requestChanges: decisionCount.get("request_changes") ?? 0 },
      flow: { secondsInReview: { p50: num(timing?.review_p50), p90: num(timing?.review_p90) } },
      queue: { waiting: queue?.waiting ?? 0, oldestSince: queue?.oldest ? new Date(queue.oldest).toISOString() : null },
      recentFailures: failures.map((r) => ({ action: r.action as string, kind: (r.kind as string | null) ?? null, caseKey: (r.case_key as string | null) ?? null, at: new Date(r.created_at).toISOString() })),
      agent: {
        proposed: healthCount.get(act("proposed")) ?? 0,
        failed: healthCount.get(act("failed")) ?? 0,
        gaveUp: healthCount.get(act("gave_up")) ?? 0,
        budgetPaused: healthCount.get(act("budget_paused")) ?? 0,
        runs: runs?.runs ?? 0,
        failedRuns: runs?.failed_runs ?? 0,
        spendUsd: usd,
        avgUsdPerRun: rate(usd, runs?.runs ?? 0),
        inputTokens: Number(runs?.input_tokens ?? 0),
        outputTokens: Number(runs?.output_tokens ?? 0),
      },
    };
  }

  return { metrics };
}
