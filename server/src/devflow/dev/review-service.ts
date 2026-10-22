import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { drAgentOutputs, drSystems, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { BA_STAGE } from "../ba/ba-service.js";
import { PLAN_STAGE } from "../plan/plan-service.js";
import { reviewAccess, type Viewer } from "../review-access.js";
import { CODE_REVIEW_STAGE, DEV_STAGE } from "./dev-service.js";
import { githubClient, type GithubClient } from "./github.js";

// Review of the Dev agent's work by staff (openspec/changes/add-dev-stage, design D7). Same shape as the plan review: the
// decision runs through the core reviewCase (which also checks the approver role, `tech_lead`) and the domain records are
// written by its beforeCommit hook. There is nothing to edit here: a reviewer who wants different code changes it on
// GitHub or sends it back with a reason. DevFlow never merges; a reject closes the pull requests, nothing more.

export const codeDecisionSchema = z.strictObject({
  outputId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().trim().max(4000).optional(),
});
export type CodeDecisionBody = z.infer<typeof codeDecisionSchema>;

type Row = Record<string, any>;
type ReviewCase = (input: any) => Promise<unknown>;

export type CodeReviewDeps = {
  reviewCase: ReviewCase;
  /** reads the token of a system's secret; null when the secret is gone */
  resolveToken?: (companyId: string, secretId: string) => Promise<string | null>;
  github?: (token: string) => GithubClient;
};

const uniqueSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

/** Why this work cannot be approved (nothing to merge, or a diff DevFlow refused to push), or null. */
export function approveBlocker(repos: readonly Row[]): "no_pull_request" | "blocked_diff" | null {
  if (repos.some((r) => r.blocked)) return "blocked_diff";
  if (repos.length === 0 || repos.some((r) => !r.prUrl)) return "no_pull_request";
  return null;
}

export function codeReviewService(db: Db, deps: CodeReviewDeps) {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];
  const github = deps.github ?? githubClient;

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
        .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, DEV_STAGE), eq(drAgentOutputs.status, "proposed")))
    )[0] ?? null;

  const summaryOf = (d: Row) => {
    const tasks: Row[] = d.tasks ?? [];
    const checks: Row[] = d.checks ?? [];
    const repos: Row[] = d.repos ?? [];
    return {
      summary: d.summary,
      confidence: d.confidence,
      systems: uniqueSorted(repos.map((r) => r.system)),
      pullRequests: repos.filter((r) => r.prUrl).map((r) => ({ system: r.system, number: r.prNumber, url: r.prUrl })),
      blocked: repos.filter((r) => r.blocked).map((r) => ({ system: r.system, kind: r.blocked.kind })),
      noChanges: repos.filter((r) => r.noChanges).map((r) => r.system),
      tasks: { total: tasks.length, done: tasks.filter((t) => t.status === "done").length, partial: tasks.filter((t) => t.status === "partial").length, skipped: tasks.filter((t) => t.status === "skipped").length },
      checks: { passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length },
      approvable: approveBlocker(repos) === null,
    };
  };

  async function queue(companyId: string) {
    const list = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, r.request_number, u.name as requester_name,
             o.id as output_id, o.prompt_version, o.created_at as proposed_at, o.data
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${CODE_REVIEW_STAGE}
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${DEV_STAGE} and o.status = 'proposed'
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

  /** Cheap count for the sidebar badge: code waiting for review and when the newest arrived. */
  async function count(companyId: string) {
    const [r] = await rows(sql`
      select count(*)::int as waiting, max(o.created_at) as newest
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${CODE_REVIEW_STAGE}
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${DEV_STAGE} and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null`);
    return { waiting: r?.waiting ?? 0, newest: r?.newest ? new Date(r.newest).toISOString() : null };
  }

  /** What reviewers approved before: the BA spec and the plan, to compare with what was built. */
  async function approvedOf(companyId: string, caseId: string, stageKey: string): Promise<Row | null> {
    const [found] = await db
      .select({ data: drAgentOutputs.data })
      .from(drAgentOutputs)
      .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, stageKey), inArray(drAgentOutputs.status, ["accepted", "overridden"])))
      .orderBy(desc(drAgentOutputs.decidedAt))
      .limit(1);
    const a = (found?.data as Row | undefined)?.approved;
    return a && typeof a === "object" ? (a as Row) : null;
  }

  async function detail(companyId: string, caseId: string, viewer: Viewer) {
    const c = await loadReviewable(companyId, caseId);
    if (!c || c.stage_key !== CODE_REVIEW_STAGE) return null;
    const output = await proposedOutput(companyId, caseId);
    if (!output) return null;
    const access = await reviewAccess(db, companyId, caseId, viewer);
    const data = output.data as Row;
    const repos: Row[] = data.repos ?? [];
    const keys = repos.map((r) => r.system);
    const systemRows = keys.length
      ? await db.select({ key: drSystems.key, name: drSystems.name, repoUrl: drSystems.repoUrl }).from(drSystems).where(and(eq(drSystems.companyId, companyId), inArray(drSystems.key, keys)))
      : [];
    const plan = await approvedOf(companyId, caseId, PLAN_STAGE);
    const spec = await approvedOf(companyId, caseId, BA_STAGE);
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
      report: Object.fromEntries(["summary", "tasks", "checks", "risks", "openQuestions", "confidence"].map((k) => [k, data[k]])),
      repos: repos.map((r) => ({ ...r, name: systemRows.find((x) => x.key === r.system)?.name ?? r.system, repoUrl: systemRows.find((x) => x.key === r.system)?.repoUrl ?? null })),
      approveBlocker: approveBlocker(repos),
      // the approved plan's tasks, to check against what the agent says it did
      planTasks: Array.isArray(plan?.tasks) ? plan.tasks.map((t: Row) => ({ id: t.id, title: t.title, system: t.system, size: t.size })) : [],
      baSpec: spec ? { summary: spec.summary ?? null, acceptanceCriteria: spec.acceptanceCriteria ?? [] } : null,
    };
  }

  /** After a reject: close the draft pull requests. A failure is recorded, never undoes the decision. */
  async function closePullRequests(companyId: string, caseId: string, userId: string, repos: readonly Row[]) {
    const results: Array<{ system: string; prNumber: number; closed: boolean }> = [];
    for (const r of repos.filter((x) => x.prNumber)) {
      let closed = false;
      let kind = "close_failed";
      try {
        const [system] = await db
          .select({ repoUrl: drSystems.repoUrl, secretId: drSystems.writeTokenSecretId })
          .from(drSystems)
          .where(and(eq(drSystems.companyId, companyId), eq(drSystems.key, r.system)));
        const token = system?.secretId && deps.resolveToken ? await deps.resolveToken(companyId, system.secretId).catch(() => null) : null;
        if (!system || !token) {
          kind = "no_write_token";
        } else {
          await github(token).closePr(system.repoUrl, r.prNumber);
          closed = true;
        }
      } catch (err) {
        kind = (err as { kind?: string }).kind ?? "close_failed";
        logger.warn({ kind }, "devflow code review: pull request not closed");
      }
      results.push({ system: r.system, prNumber: r.prNumber, closed });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: closed ? "code.pr_closed" : "code.pr_close_failed",
        entityType: "pipeline_case",
        entityId: caseId,
        details: { system: r.system, prNumber: r.prNumber, ...(closed ? {} : { kind }) },
      }).catch(() => undefined);
    }
    return results;
  }

  async function decide(input: { companyId: string; caseId: string; userId: string; instanceAdmin?: boolean; body: CodeDecisionBody }) {
    const { companyId, caseId, userId, body } = input;
    const c = await loadReviewable(companyId, caseId);
    if (!c) throw notFound("Request not found");
    if (c.stage_key !== CODE_REVIEW_STAGE) throw conflict("This request is no longer waiting for code review");
    if (c.requester_user_id === userId) throw forbidden("You cannot review your own request");
    const output = await proposedOutput(companyId, caseId);
    if (!output || output.id !== body.outputId) throw conflict("The proposal changed; reload and review again");
    const data = output.data as Row;
    const repos: Row[] = data.repos ?? [];
    if (body.decision === "approve") {
      const blocker = approveBlocker(repos);
      if (blocker) {
        throw unprocessable(
          blocker === "blocked_diff" ? "DevFlow did not push this work (a check refused the diff); send it back or reject it" : "There is no pull request to approve; send the request back or reject it",
          { code: "validation" },
        );
      }
    }

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
          // what later stages read: the pull requests and what was built, in one place
          const approved = body.decision === "approve" ? { summary: data.summary, repos, tasks: data.tasks, checks: data.checks } : null;
          await tx
            .update(drAgentOutputs)
            .set({ status: body.decision === "approve" ? "accepted" : "superseded", decidedAt: new Date(), decidedByUserId: userId, ...(approved ? { data: { ...data, approved } } : {}) })
            .where(eq(drAgentOutputs.id, output.id));
          await logActivity(tx, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "code.decided",
            entityType: "pipeline_case",
            entityId: caseId,
            details: { decision: body.decision, outputId: output.id, pullRequests: repos.filter((r) => r.prNumber).map((r) => r.prNumber) },
          });
        },
      });
    } catch (err) {
      // Another reviewer got in between our checks and the core transaction: report that as a conflict.
      const now = await loadReviewable(companyId, caseId);
      if (!now || now.stage_key !== CODE_REVIEW_STAGE) throw conflict("This request is no longer waiting for code review");
      throw err;
    }
    const closed = body.decision === "reject" ? await closePullRequests(companyId, caseId, userId, repos) : [];
    return { ok: true as const, decision: body.decision, closedPullRequests: closed };
  }

  return { queue, count, detail, decide };
}
