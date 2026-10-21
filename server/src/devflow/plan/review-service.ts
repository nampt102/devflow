import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { drAgentOutputs, drOverrides, drSystems, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { BA_STAGE } from "../ba/ba-service.js";
import { reviewAccess, type Viewer } from "../review-access.js";
import { PLAN_REVIEW_STAGE, PLAN_STAGE } from "./plan-service.js";
import { planCommentMarkdown, planOutputSchema, planTaskSchema, type PlanOutput, type PlanTask } from "./schema.js";

// Review of technical plans by staff (openspec/changes/add-tech-plan-stage, design D6). Same shape as the BA review:
// the decision runs through the core reviewCase and the domain records are written by its beforeCommit hook.

/** Text fields a reviewer may correct. Task structure (systems, files, dependencies) is the agent's; a wrong one is sent back. */
const EDITABLE = ["summary", "approach", "dataChanges", "apiChanges", "testPlan", "risks", "openQuestions"] as const;
type EditableField = (typeof EDITABLE)[number];
const editableShape = Object.fromEntries(EDITABLE.map((k) => [k, true])) as Record<EditableField, true>;
const taskEdit = planTaskSchema.pick({ id: true, title: true, description: true, size: true });

export const planDecisionSchema = z.strictObject({
  outputId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().trim().max(4000).optional(),
  final: planOutputSchema
    .pick(editableShape)
    .partial()
    .extend({ tasks: z.array(taskEdit).max(30).optional() })
    .strict()
    .optional(),
});
export type PlanDecisionBody = z.infer<typeof planDecisionSchema>;

type Row = Record<string, any>;
type ReviewCase = (input: any) => Promise<unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const uniqueSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

/** The agent's tasks with the reviewer's title, description and size; null when the edit changes the task list itself. */
export function applyTaskEdits(agentTasks: readonly PlanTask[], edits: ReadonlyArray<z.infer<typeof taskEdit>> | undefined): PlanTask[] | null {
  if (edits === undefined) return [...agentTasks];
  if (edits.length !== agentTasks.length || edits.some((e, i) => e.id !== agentTasks[i]!.id)) return null;
  return agentTasks.map((t, i) => ({ ...t, title: edits[i]!.title, description: edits[i]!.description, size: edits[i]!.size }));
}

export function planReviewService(db: Db, deps: { reviewCase: ReviewCase }) {
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
        .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, PLAN_STAGE), eq(drAgentOutputs.status, "proposed")))
    )[0] ?? null;

  const summaryOf = (d: Row) => {
    const tasks: Row[] = d.tasks ?? [];
    return {
      summary: d.summary,
      confidence: d.confidence,
      systems: uniqueSorted((d.repos ?? []).map((r: Row) => r.system)),
      tasks: tasks.length,
      sizes: { S: tasks.filter((t) => t.size === "S").length, M: tasks.filter((t) => t.size === "M").length, L: tasks.filter((t) => t.size === "L").length },
      openQuestions: (d.openQuestions ?? []).length,
    };
  };

  async function queue(companyId: string) {
    const list = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, r.request_number, u.name as requester_name,
             o.id as output_id, o.prompt_version, o.created_at as proposed_at, o.data
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${PLAN_REVIEW_STAGE}
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${PLAN_STAGE} and o.status = 'proposed'
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

  /** Cheap count for the sidebar badge: plans waiting for review and when the newest one arrived. */
  async function count(companyId: string) {
    const [r] = await rows(sql`
      select count(*)::int as waiting, max(o.created_at) as newest
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${PLAN_REVIEW_STAGE}
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${PLAN_STAGE} and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null`);
    return { waiting: r?.waiting ?? 0, newest: r?.newest ? new Date(r.newest).toISOString() : null };
  }

  /** The approved BA spec the plan was made from, for the reviewer to compare. */
  async function approvedSpec(companyId: string, caseId: string) {
    const [spec] = await db
      .select({ data: drAgentOutputs.data })
      .from(drAgentOutputs)
      .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, BA_STAGE), inArray(drAgentOutputs.status, ["accepted", "overridden"])))
      .orderBy(desc(drAgentOutputs.decidedAt))
      .limit(1);
    const a = (spec?.data as Row | undefined)?.approved as Row | undefined;
    return a ? { summary: a.summary ?? null, inScope: a.inScope ?? [], acceptanceCriteria: a.acceptanceCriteria ?? [] } : null;
  }

  async function detail(companyId: string, caseId: string, viewer: Viewer) {
    const c = await loadReviewable(companyId, caseId);
    if (!c || c.stage_key !== PLAN_REVIEW_STAGE) return null;
    const output = await proposedOutput(companyId, caseId);
    if (!output) return null;
    const access = await reviewAccess(db, companyId, caseId, viewer);
    const data = output.data as Row;
    // repository addresses of the systems the agent read, so a citation can link to the exact commit
    const repoKeys: string[] = (data.repos ?? []).map((r: Row) => r.system);
    const repoRows = repoKeys.length
      ? await db.select({ key: drSystems.key, name: drSystems.name, repoUrl: drSystems.repoUrl }).from(drSystems).where(and(eq(drSystems.companyId, companyId), inArray(drSystems.key, repoKeys)))
      : [];
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
      plan: Object.fromEntries([...EDITABLE, "tasks", "confidence"].map((k) => [k, data[k]])),
      repos: (data.repos ?? []).map((r: Row) => ({ system: r.system, sha: r.sha, name: repoRows.find((x) => x.key === r.system)?.name ?? r.system, repoUrl: repoRows.find((x) => x.key === r.system)?.repoUrl ?? null })),
      baSpec: await approvedSpec(companyId, caseId),
    };
  }

  async function decide(input: { companyId: string; caseId: string; userId: string; instanceAdmin?: boolean; body: PlanDecisionBody }) {
    const { companyId, caseId, userId, body } = input;
    const c = await loadReviewable(companyId, caseId);
    if (!c) throw notFound("Request not found");
    if (c.stage_key !== PLAN_REVIEW_STAGE) throw conflict("This request is no longer waiting for plan review");
    if (c.requester_user_id === userId) throw forbidden("You cannot review your own request");
    const output = await proposedOutput(companyId, caseId);
    if (!output || output.id !== body.outputId) throw conflict("The proposal changed; reload and review again");
    const data = output.data as Row;

    // the final plan: the agent's text with the reviewer's corrections on top
    const patch = (body.final ?? {}) as Row;
    const finalPlan: Row = {};
    for (const k of EDITABLE) finalPlan[k] = patch[k] !== undefined ? patch[k] : data[k];
    const finalTasks = applyTaskEdits(data.tasks ?? [], body.final?.tasks);
    if (!finalTasks) throw unprocessable("Tasks can only change their title, description and size; send the plan back to change the task list", { code: "validation" });

    const overridden: string[] = [];
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

          if (body.decision === "approve") {
            const changes: Array<[string, unknown, unknown]> = [...EDITABLE.map((k) => [k, data[k], finalPlan[k]] as [string, unknown, unknown]), ["tasks", data.tasks, finalTasks]];
            for (const [field, agentValue, finalValue] of changes) {
              if (same(agentValue, finalValue)) continue;
              await tx.insert(drOverrides).values({ companyId, caseId, outputId: output.id, stageKey: PLAN_STAGE, field, agentValue: agentValue ?? null, finalValue: finalValue ?? null, actorUserId: userId });
              overridden.push(field);
            }
          }
          // the approved plan is kept with the proposal, so later stages read one place: data.approved
          const approved = body.decision === "approve" ? ({ ...finalPlan, tasks: finalTasks, confidence: data.confidence } as PlanOutput) : null;
          await tx
            .update(drAgentOutputs)
            .set({
              status: body.decision === "approve" ? (overridden.length ? "overridden" : "accepted") : "superseded",
              decidedAt: new Date(),
              decidedByUserId: userId,
              ...(approved ? { data: { ...data, approved }, commentText: planCommentMarkdown(approved) } : {}),
            })
            .where(eq(drAgentOutputs.id, output.id));
          await logActivity(tx, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "plan.decided",
            entityType: "pipeline_case",
            entityId: caseId,
            details: { decision: body.decision, outputId: output.id, overriddenFields: overridden },
          });
        },
      });
    } catch (err) {
      // Another reviewer got in between our checks and the core transaction: report that as a conflict.
      const now = await loadReviewable(companyId, caseId);
      if (!now || now.stage_key !== PLAN_REVIEW_STAGE) throw conflict("This request is no longer waiting for plan review");
      throw err;
    }
    return { ok: true as const, decision: body.decision, overriddenFields: overridden };
  }

  return { queue, count, detail, decide };
}
