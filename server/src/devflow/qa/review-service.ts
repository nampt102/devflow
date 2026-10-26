import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { drAgentOutputs, drSystems, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { DEV_STAGE } from "../dev/dev-service.js";
import { closePullRequests, type PrCloseDeps } from "../dev/close-prs.js";
import { reviewAccess, type Viewer } from "../review-access.js";
import { QA_SIGNOFF_STAGE, QA_STAGE } from "./qa-service.js";

// QA sign-off by staff (openspec/changes/add-qa-stage, design D5). Same shape as the Code review: the decision runs through
// the core reviewCase (which also checks the approver role, `qa` or `tech_lead`) and the domain records are written by its
// beforeCommit hook. DevFlow's recommendation is shown, never enforced: the person who signs off decides. Nothing is merged.

export const qaDecisionSchema = z.strictObject({
  outputId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().trim().max(4000).optional(),
});
export type QaDecisionBody = z.infer<typeof qaDecisionSchema>;

type Row = Record<string, any>;
type ReviewCase = (input: any) => Promise<unknown>;

export type QaReviewDeps = PrCloseDeps & { reviewCase: ReviewCase };

const uniqueSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

export function qaReviewService(db: Db, deps: QaReviewDeps) {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

  async function loadReviewable(companyId: string, caseId: string) {
    const [row] = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, st.key as stage_key,
             r.request_number, r.description, r.business_impact, r.classification, r.priority, r.difficulty,
             rq.user_id as requester_user_id, u.name as requester_name
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      where c.company_id = ${companyId} and c.id = ${caseId}`);
    return row ?? null;
  }

  const proposedOutput = async (companyId: string, caseId: string) =>
    (
      await db
        .select()
        .from(drAgentOutputs)
        .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, QA_STAGE), eq(drAgentOutputs.status, "proposed")))
    )[0] ?? null;

  const summaryOf = (d: Row) => {
    const criteria: Row[] = d.criteria ?? [];
    const checks: Row[] = d.checks ?? [];
    const issues: Row[] = d.issues ?? [];
    return {
      summary: d.summary,
      confidence: d.confidence,
      recommendation: d.recommendation?.value ?? null,
      warnings: d.warnings ?? [],
      systems: uniqueSorted((d.repos ?? []).map((r: Row) => r.system)),
      pullRequests: (d.repos ?? []).filter((r: Row) => r.prUrl).map((r: Row) => ({ system: r.system, number: r.prNumber, url: r.prUrl })),
      criteria: { total: criteria.length, pass: criteria.filter((c) => c.verdict === "pass").length, fail: criteria.filter((c) => c.verdict === "fail").length, notVerified: criteria.filter((c) => c.verdict === "not_verified").length },
      checks: { passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length },
      issues: { high: issues.filter((i) => i.severity === "high").length, total: issues.length },
    };
  };

  async function queue(companyId: string) {
    const list = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, r.request_number, u.name as requester_name,
             o.id as output_id, o.prompt_version, o.created_at as proposed_at, o.data
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${QA_SIGNOFF_STAGE}
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${QA_STAGE} and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null
      order by c.created_at, c.id
      limit 200`);
    return {
      items: list.map((r) => ({
        caseId: r.case_id,
        caseKey: r.case_key,
        requestNumber: r.request_number,
        title: r.title,
        requesterName: r.requester_name,
        createdAt: r.created_at,
        version: r.version,
        outputId: r.output_id,
        promptVersion: r.prompt_version,
        proposedAt: r.proposed_at,
        proposal: summaryOf(r.data ?? {}),
      })),
    };
  }

  /** Cheap count for the sidebar badge: QA reports waiting for sign-off and when the newest arrived. */
  async function count(companyId: string) {
    const [r] = await rows(sql`
      select count(*)::int as waiting, max(o.created_at) as newest
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${QA_SIGNOFF_STAGE}
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${QA_STAGE} and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null`);
    return { waiting: r?.waiting ?? 0, newest: r?.newest ? new Date(r.newest).toISOString() : null };
  }

  async function detail(companyId: string, caseId: string, viewer: Viewer) {
    const c = await loadReviewable(companyId, caseId);
    if (!c || c.stage_key !== QA_SIGNOFF_STAGE) return null;
    const output = await proposedOutput(companyId, caseId);
    if (!output) return null;
    const access = await reviewAccess(db, companyId, caseId, viewer);
    const data = output.data as Row;
    const repos: Row[] = data.repos ?? [];
    const keys = repos.map((r) => r.system);
    const systemRows = keys.length
      ? await db.select({ key: drSystems.key, name: drSystems.name, repoUrl: drSystems.repoUrl }).from(drSystems).where(and(eq(drSystems.companyId, companyId), inArray(drSystems.key, keys)))
      : [];
    const text: Record<string, string> = data.criteriaText ?? {};
    return {
      ...access,
      caseId: c.case_id,
      caseKey: c.case_key,
      requestNumber: c.request_number,
      title: c.title,
      description: c.description,
      businessImpact: c.business_impact,
      triage: { classification: c.classification, priority: c.priority, difficulty: c.difficulty },
      requesterName: c.requester_name,
      createdAt: c.created_at,
      version: c.version,
      outputId: output.id,
      promptVersion: output.promptVersion,
      model: data.model ?? null,
      costUsd: typeof data.costUsd === "number" ? data.costUsd : null,
      report: {
        summary: data.summary,
        criteria: (data.criteria ?? []).map((k: Row) => ({ ...k, text: text[k.id] ?? "" })),
        checks: data.checks ?? [],
        issues: data.issues ?? [],
        manualTests: data.manualTests ?? [],
        confidence: data.confidence,
      },
      recommendation: data.recommendation ?? { value: "changes", reasons: [] },
      warnings: data.warnings ?? [],
      repos: repos.map((r) => ({ ...r, name: systemRows.find((x) => x.key === r.system)?.name ?? r.system, repoUrl: systemRows.find((x) => x.key === r.system)?.repoUrl ?? null })),
    };
  }

  async function decide(input: { companyId: string; caseId: string; userId: string; instanceAdmin?: boolean; body: QaDecisionBody }) {
    const { companyId, caseId, userId, body } = input;
    const c = await loadReviewable(companyId, caseId);
    if (!c) throw notFound("Request not found");
    if (c.stage_key !== QA_SIGNOFF_STAGE) throw conflict("This request is no longer waiting for QA sign-off");
    if (c.requester_user_id === userId) throw forbidden("You cannot review your own request");
    const output = await proposedOutput(companyId, caseId);
    if (!output || output.id !== body.outputId) throw conflict("The proposal changed; reload and review again");
    const data = output.data as Row;
    const repos: Row[] = data.repos ?? [];

    try {
      await deps.reviewCase({
        companyId,
        caseId,
        decision: body.decision,
        reason: body.reason?.trim() || undefined,
        expectedVersion: body.expectedVersion,
        actor: { type: "user", userId, instanceAdmin: input.instanceAdmin === true },
        beforeCommit: async (txRaw: unknown) => {
          const tx = txRaw as Db;
          const [live] = await tx.select({ status: drAgentOutputs.status }).from(drAgentOutputs).where(eq(drAgentOutputs.id, output.id)).for("update");
          if (live?.status !== "proposed") throw conflict("The proposal changed; reload and review again");
          const approved = body.decision === "approve" ? { summary: data.summary, criteria: data.criteria, repos, recommendation: data.recommendation } : null;
          await tx
            .update(drAgentOutputs)
            .set({ status: body.decision === "approve" ? "accepted" : "superseded", decidedAt: new Date(), decidedByUserId: userId, ...(approved ? { data: { ...data, approved } } : {}) })
            .where(eq(drAgentOutputs.id, output.id));
          if (body.decision === "request_changes") {
            // the request goes back to Dev: its approved work is no longer approved, which is also how the Dev worker finds the
            // reviewer's reason and the QA findings to continue from (dev-service: feedback after a superseded proposal)
            const [devWork] = await tx
              .select({ id: drAgentOutputs.id })
              .from(drAgentOutputs)
              .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, DEV_STAGE), eq(drAgentOutputs.status, "accepted")))
              .orderBy(desc(drAgentOutputs.decidedAt))
              .limit(1);
            if (devWork) await tx.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.id, devWork.id));
          }
          await logActivity(tx, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "qa.decided",
            entityType: "pipeline_case",
            entityId: caseId,
            details: { decision: body.decision, outputId: output.id, recommendation: data.recommendation?.value ?? null, pullRequests: repos.filter((r) => r.prNumber).map((r) => r.prNumber) },
          });
        },
      });
    } catch (err) {
      // Another reviewer got in between our checks and the core transaction: report that as a conflict.
      const now = await loadReviewable(companyId, caseId);
      if (!now || now.stage_key !== QA_SIGNOFF_STAGE) throw conflict("This request is no longer waiting for QA sign-off");
      throw err;
    }
    const closed = body.decision === "reject" ? await closePullRequests(db, deps, companyId, caseId, userId, repos) : [];
    return { ok: true as const, decision: body.decision, closedPullRequests: closed };
  }

  /**
   * How often the person who signs off goes against DevFlow's recommendation (approves when it said "changes", or sends back or
   * rejects when it said "approve"): the measure of how far the QA agent can be trusted, like the override rate of the other stages.
   */
  async function recommendationAgreement(companyId: string, days: number) {
    const [r] = await rows(sql`
      select count(*)::int as decided,
             (count(*) filter (where o.status = 'accepted' and o.data->'recommendation'->>'value' = 'changes'))::int as approved_against,
             (count(*) filter (where o.status = 'superseded' and o.data->'recommendation'->>'value' = 'approve'))::int as returned_against
      from dr_agent_outputs o
      where o.company_id = ${companyId} and o.stage_key = ${QA_STAGE} and o.decided_at is not null
        and o.decided_at >= now() - make_interval(days => ${days})`);
    const decided = r?.decided ?? 0;
    const against = (r?.approved_against ?? 0) + (r?.returned_against ?? 0);
    return { decided, approvedAgainst: r?.approved_against ?? 0, returnedAgainst: r?.returned_against ?? 0, againstRate: decided > 0 ? against / decided : null };
  }

  return { queue, count, detail, decide, recommendationAgreement };
}
