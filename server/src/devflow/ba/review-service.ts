import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { drAgentOutputs, drOverrides, drRequestSystems, drSystems, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { BA_REVIEW_STAGE, BA_STAGE } from "./ba-service.js";
import { baCommentMarkdown, baOutputSchema, type BaOutput } from "./schema.js";

// Review of BA specs by staff (openspec/changes/add-ba-spec-stage, design D5). Same shape as the Triage review:
// the decision runs through the core reviewCase and the domain records are written by its beforeCommit hook.

/** What a reviewer may correct. Citations (affectedAreas) and confidence are the agent's own; a wrong one is sent back. */
const EDITABLE = ["summary", "businessGoal", "inScope", "outOfScope", "userStories", "acceptanceCriteria", "dataChanges", "risks", "openQuestions"] as const;
type EditableField = (typeof EDITABLE)[number];
const editableShape = Object.fromEntries(EDITABLE.map((k) => [k, true])) as Record<EditableField, true>;

export const baDecisionSchema = z.strictObject({
  outputId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().trim().max(4000).optional(),
  // the systems the BA agent reads; applies to approve and to request_changes (the next run uses the new scope)
  systemIds: z.array(z.string().uuid()).max(10).optional(),
  final: baOutputSchema.pick(editableShape).partial().optional(),
});
export type BaDecisionBody = z.infer<typeof baDecisionSchema>;

type Row = Record<string, any>;
type ReviewCase = (input: any) => Promise<unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const uniqueSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

export function baReviewService(db: Db, deps: { reviewCase: ReviewCase }) {
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
        .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, BA_STAGE), eq(drAgentOutputs.status, "proposed")))
    )[0] ?? null;

  const summaryOf = (d: Row) => ({
    summary: d.summary,
    confidence: d.confidence,
    systems: uniqueSorted((d.repos ?? []).map((r: Row) => r.system)),
    openQuestions: (d.openQuestions ?? []).length,
    acceptanceCriteria: (d.acceptanceCriteria ?? []).length,
  });

  async function queue(companyId: string) {
    const list = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, r.request_number, u.name as requester_name,
             o.id as output_id, o.prompt_version, o.created_at as proposed_at, o.data
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${BA_REVIEW_STAGE}
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${BA_STAGE} and o.status = 'proposed'
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

  /** Cheap count for the sidebar badge: specs waiting for review and when the newest one arrived. */
  async function count(companyId: string) {
    const [r] = await rows(sql`
      select count(*)::int as waiting, max(o.created_at) as newest
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = ${BA_REVIEW_STAGE}
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = ${BA_STAGE} and o.status = 'proposed'
      where c.company_id = ${companyId} and c.terminal_kind is null`);
    return { waiting: r?.waiting ?? 0, newest: r?.newest ? new Date(r.newest).toISOString() : null };
  }

  async function systemsFor(companyId: string, caseId: string) {
    const available = await db
      .select({ id: drSystems.id, key: drSystems.key, name: drSystems.name, description: drSystems.description })
      .from(drSystems)
      .where(and(eq(drSystems.companyId, companyId), eq(drSystems.active, true)))
      .orderBy(drSystems.name, drSystems.key);
    const assigned = await db
      .select({ systemId: drRequestSystems.systemId })
      .from(drRequestSystems)
      .where(and(eq(drRequestSystems.caseId, caseId), eq(drRequestSystems.companyId, companyId)));
    const ids = new Set(assigned.map((a) => a.systemId));
    return { available, selectedIds: available.filter((a) => ids.has(a.id)).map((a) => a.id) };
  }

  async function detail(companyId: string, caseId: string) {
    const c = await loadReviewable(companyId, caseId);
    if (!c || c.stage_key !== BA_REVIEW_STAGE) return null;
    const output = await proposedOutput(companyId, caseId);
    if (!output) return null;
    const attachments = await rows(sql`
      select a.id, a.asset_id, s.original_filename as name, s.content_type, s.byte_size
      from dr_attachments a join assets s on s.id = a.asset_id
      where a.case_id = ${caseId} and a.company_id = ${companyId} order by a.created_at`);
    const data = output.data as Row;
    // repository addresses of the systems the agent read, so a citation can link to the exact commit
    const repoKeys: string[] = (data.repos ?? []).map((r: Row) => r.system);
    const repoRows = repoKeys.length
      ? await db.select({ key: drSystems.key, name: drSystems.name, repoUrl: drSystems.repoUrl }).from(drSystems).where(and(eq(drSystems.companyId, companyId)))
      : [];
    return {
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
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, contentType: a.content_type, size: a.byte_size, contentPath: `/api/assets/${a.asset_id}/content` })),
      outputId: output.id,
      promptVersion: output.promptVersion,
      model: data.model ?? null,
      costUsd: typeof data.costUsd === "number" ? data.costUsd : null,
      spec: Object.fromEntries([...EDITABLE, "affectedAreas", "confidence"].map((k) => [k, data[k]])),
      repos: (data.repos ?? []).map((r: Row) => ({ system: r.system, sha: r.sha, name: repoRows.find((x) => x.key === r.system)?.name ?? r.system, repoUrl: repoRows.find((x) => x.key === r.system)?.repoUrl ?? null })),
      systems: await systemsFor(companyId, caseId),
    };
  }

  async function decide(input: { companyId: string; caseId: string; userId: string; body: BaDecisionBody }) {
    const { companyId, caseId, userId, body } = input;
    const c = await loadReviewable(companyId, caseId);
    if (!c) throw notFound("Request not found");
    if (c.stage_key !== BA_REVIEW_STAGE) throw conflict("This request is no longer waiting for BA review");
    if (c.requester_user_id === userId) throw forbidden("You cannot review your own request");
    const output = await proposedOutput(companyId, caseId);
    if (!output || output.id !== body.outputId) throw conflict("The proposal changed; reload and review again");
    const data = output.data as Row;

    // the final spec: the agent's text with the reviewer's corrections on top
    const patch = body.final ?? {};
    const finalSpec: Row = {};
    for (const k of EDITABLE) finalSpec[k] = (patch as Row)[k] !== undefined ? (patch as Row)[k] : data[k];
    // the schema already demands at least one acceptance criterion and one in-scope item, for the agent and for edits alike

    // systems: only when the reviewer sent a list; they must be switched-on systems of this company
    let systemChange: string[] | null = null;
    if (body.systemIds !== undefined && body.decision !== "reject") {
      const companySystems = await db
        .select({ id: drSystems.id })
        .from(drSystems)
        .where(and(eq(drSystems.companyId, companyId), eq(drSystems.active, true)));
      const known = new Set(companySystems.map((x) => x.id));
      systemChange = uniqueSorted(body.systemIds);
      if (systemChange.some((id) => !known.has(id))) throw unprocessable("A chosen system is not an active system of this company", { code: "validation" });
    }

    const overridden: string[] = [];
    try {
      await deps.reviewCase({
        companyId,
        caseId,
        decision: body.decision,
        reason: body.reason?.trim() || undefined,
        expectedVersion: body.expectedVersion,
        actor: { type: "user", userId },
        beforeCommit: async (txRaw: unknown) => {
          const tx = txRaw as Db;
          const [live] = await tx.select({ status: drAgentOutputs.status }).from(drAgentOutputs).where(eq(drAgentOutputs.id, output.id)).for("update");
          if (live?.status !== "proposed") throw conflict("The proposal changed; reload and review again");

          if (body.decision === "approve") {
            for (const k of EDITABLE) {
              if (same(data[k], finalSpec[k])) continue;
              await tx.insert(drOverrides).values({ companyId, caseId, outputId: output.id, stageKey: BA_STAGE, field: k, agentValue: data[k] ?? null, finalValue: finalSpec[k] ?? null, actorUserId: userId });
              overridden.push(k);
            }
          }
          if (systemChange) {
            await tx.delete(drRequestSystems).where(and(eq(drRequestSystems.caseId, caseId), eq(drRequestSystems.companyId, companyId)));
            if (systemChange.length) await tx.insert(drRequestSystems).values(systemChange.map((systemId) => ({ companyId, caseId, systemId, assignedByUserId: userId })));
          }
          // the approved spec is kept with the proposal, so later stages read one place: data.approved
          const approved = body.decision === "approve" ? { ...(finalSpec as Pick<BaOutput, EditableField>), affectedAreas: data.affectedAreas ?? [], confidence: data.confidence } : null;
          await tx
            .update(drAgentOutputs)
            .set({
              status: body.decision === "approve" ? (overridden.length ? "overridden" : "accepted") : "superseded",
              decidedAt: new Date(),
              decidedByUserId: userId,
              ...(approved ? { data: { ...data, approved }, commentText: baCommentMarkdown(approved as BaOutput) } : {}),
            })
            .where(eq(drAgentOutputs.id, output.id));
          await logActivity(tx, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "ba.decided",
            entityType: "pipeline_case",
            entityId: caseId,
            details: { decision: body.decision, outputId: output.id, overriddenFields: overridden, systemsChanged: systemChange !== null },
          });
        },
      });
    } catch (err) {
      // Another reviewer got in between our checks and the core transaction: report that as a conflict.
      const now = await loadReviewable(companyId, caseId);
      if (!now || now.stage_key !== BA_REVIEW_STAGE) throw conflict("This request is no longer waiting for BA review");
      throw err;
    }
    return { ok: true as const, decision: body.decision, overriddenFields: overridden };
  }

  return { queue, count, detail, decide };
}
