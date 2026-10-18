import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { drAgentOutputs, drOverrides, drRequests, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { statusLabelVi } from "../portal/status-labels.js";
import { REQUIRES_HUMAN_REASONS, triageOutputSchema } from "../triage/schema.js";

// Review of Triage proposals by staff (step 8, openspec/decisions/0017). The decision runs through the
// core reviewCase; domain records are written by its beforeCommit hook, in the same transaction.

const FIELD_ENUMS = triageOutputSchema.shape;
export const decisionSchema = z.strictObject({
  outputId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().trim().max(4000).optional(),
  final: z
    .strictObject({
      classification: FIELD_ENUMS.classification,
      priority: FIELD_ENUMS.priority,
      difficulty: FIELD_ENUMS.difficulty,
      requiresHuman: z.boolean(),
      requiresHumanReasons: z.array(z.enum(REQUIRES_HUMAN_REASONS)).max(REQUIRES_HUMAN_REASONS.length),
      duplicateOfCaseId: z.string().uuid().nullable(),
    })
    .partial()
    .optional(),
});
export type DecisionBody = z.infer<typeof decisionSchema>;

type Row = Record<string, any>;
type ReviewCase = (input: any) => Promise<unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const uniqueSorted = (xs: readonly string[]) => [...new Set(xs)].sort();

export function triageReviewService(db: Db, deps: { reviewCase: ReviewCase }) {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as Row[];

  /** The request under review, scoped to the company and to the review stage. Null when not found. */
  async function loadReviewable(companyId: string, caseId: string) {
    const [row] = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, st.key as stage_key,
             r.request_number, r.description, r.business_impact, rq.user_id as requester_user_id, u.name as requester_name
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
        .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "triage"), eq(drAgentOutputs.status, "proposed")))
    )[0] ?? null;

  const proposalSummary = (d: Row) => ({
    classification: d.classification,
    priority: d.priority,
    difficulty: d.difficulty,
    requiresHuman: !!d.requiresHuman,
    requiresHumanReasons: d.requiresHumanReasons ?? [],
    ruleFlags: d.ruleFlags ?? [],
    confidence: d.confidence,
    summary: d.summary,
    duplicateCandidates: (d.duplicateCandidates ?? []).length,
  });

  async function queue(companyId: string) {
    const list = await rows(sql`
      select c.id as case_id, c.case_key, c.title, c.version, c.created_at, r.request_number, u.name as requester_name,
             (select count(*)::int from dr_attachments a where a.case_id = c.id and a.company_id = c.company_id) as attachments,
             o.id as output_id, o.prompt_version, o.data
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id and st.key = 'triage_review'
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      join dr_requesters rq on rq.id = r.requester_id and rq.company_id = r.company_id
      join "user" u on u.id = rq.user_id
      join dr_agent_outputs o on o.case_id = c.id and o.company_id = c.company_id and o.stage_key = 'triage' and o.status = 'proposed'
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
        attachments: r.attachments,
        createdAt: r.created_at,
        version: r.version,
        outputId: r.output_id,
        promptVersion: r.prompt_version,
        proposal: proposalSummary(r.data ?? {}),
      })),
    };
  }

  async function candidatesFor(companyId: string, data: Row) {
    const keys = uniqueSorted([...(data.candidateScores ?? []).map((c: Row) => c.caseKey), ...(data.duplicateCandidates ?? []).map((c: Row) => c.caseKey)]);
    if (!keys.length) return [];
    const found = await rows(sql`
      select c.id as case_id, c.case_key, c.title, st.key as stage_key, r.request_number
      from pipeline_cases c
      join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
      join pipeline_stages st on st.id = c.stage_id
      join dr_requests r on r.case_id = c.id and r.company_id = c.company_id
      where c.company_id = ${companyId} and c.case_key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`);
    return found.map((f) => {
      const score = (data.candidateScores ?? []).find((c: Row) => c.caseKey === f.case_key) ?? {};
      const named = (data.duplicateCandidates ?? []).find((c: Row) => c.caseKey === f.case_key);
      return {
        caseId: f.case_id,
        caseKey: f.case_key,
        requestNumber: f.request_number,
        title: f.title,
        statusLabel: statusLabelVi(f.stage_key),
        trigram: score.trigram ?? null,
        vector: score.vector ?? null,
        modelReason: named?.reason ?? null,
        namedByModel: !!named,
      };
    });
  }

  async function detail(companyId: string, caseId: string) {
    const c = await loadReviewable(companyId, caseId);
    if (!c || c.stage_key !== "triage_review") return null;
    const output = await proposedOutput(companyId, caseId);
    if (!output) return null;
    const attachments = await rows(sql`
      select a.id, a.asset_id, s.original_filename as name, s.content_type, s.byte_size
      from dr_attachments a join assets s on s.id = a.asset_id
      where a.case_id = ${caseId} and a.company_id = ${companyId} order by a.created_at`);
    const data = output.data as Row;
    return {
      caseId: c.case_id,
      caseKey: c.case_key,
      requestNumber: c.request_number,
      title: c.title,
      description: c.description,
      businessImpact: c.business_impact,
      requesterName: c.requester_name,
      createdAt: c.created_at,
      version: c.version,
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, contentType: a.content_type, size: a.byte_size, contentPath: `/api/assets/${a.asset_id}/content` })),
      outputId: output.id,
      promptVersion: output.promptVersion,
      model: data.model ?? null,
      proposal: {
        ...proposalSummary(data),
        classificationReason: data.classificationReason,
        priorityReason: data.priorityReason,
        difficultyReason: data.difficultyReason,
        assumptions: data.assumptions ?? [],
        openQuestions: data.openQuestions ?? [],
        modelRequiresHumanReasons: data.modelRequiresHumanReasons ?? [],
        dedupeMode: data.dedupeMode ?? null,
      },
      candidates: await candidatesFor(companyId, data),
    };
  }

  async function decide(input: { companyId: string; caseId: string; userId: string; body: DecisionBody }) {
    const { companyId, caseId, userId, body } = input;
    const c = await loadReviewable(companyId, caseId);
    if (!c) throw notFound("Request not found");
    if (c.stage_key !== "triage_review") throw conflict("This request is no longer waiting for triage review");
    if (c.requester_user_id === userId) throw forbidden("You cannot review your own request");
    const output = await proposedOutput(companyId, caseId);
    if (!output || output.id !== body.outputId) throw conflict("The proposal changed; reload and review again");
    const data = output.data as Row;

    const candidates = await candidatesFor(companyId, data);
    const firstNamed = (data.duplicateCandidates ?? [])[0]?.caseKey as string | undefined;
    const keyOf = (id: string | null) => (id ? candidates.find((x) => x.caseId === id)?.caseKey ?? id : null);
    const agent = {
      classification: data.classification as string,
      priority: data.priority as string,
      difficulty: data.difficulty as string,
      requiresHuman: !!data.requiresHuman,
      requiresHumanReasons: uniqueSorted(data.requiresHumanReasons ?? []),
      duplicateOfCaseId: firstNamed ? candidates.find((x) => x.caseKey === firstNamed)?.caseId ?? null : null,
    };
    const patch = body.final ?? {};
    const final = {
      ...agent,
      ...patch,
      requiresHumanReasons: uniqueSorted(patch.requiresHumanReasons ?? agent.requiresHumanReasons),
      duplicateOfCaseId: patch.duplicateOfCaseId !== undefined ? patch.duplicateOfCaseId : agent.duplicateOfCaseId,
    };

    if (!final.requiresHuman && final.requiresHumanReasons.length) throw unprocessable("Reasons need requiresHuman to be true", { code: "validation" });
    if (body.decision === "approve" && final.duplicateOfCaseId) throw unprocessable("Mark a duplicate with reject, not approve", { code: "validation" });
    let duplicateKey: string | null = null;
    if (final.duplicateOfCaseId) {
      if (final.duplicateOfCaseId === caseId) throw unprocessable("A request cannot duplicate itself", { code: "validation" });
      const [dup] = await rows(sql`
        select c.case_key from pipeline_cases c join pipelines p on p.id = c.pipeline_id and p.key = 'dev-request'
        where c.company_id = ${companyId} and c.id = ${final.duplicateOfCaseId}`);
      if (!dup) throw unprocessable("The duplicate target is not a request of this company", { code: "validation" });
      duplicateKey = dup.case_key;
    }
    const reason =
      body.reason?.trim() ||
      (body.decision === "reject" && duplicateKey ? `Duplicate of ${duplicateKey}` : undefined);

    const overridden: string[] = [];
    try {
      await deps.reviewCase({
        companyId,
        caseId,
        decision: body.decision,
        reason,
        expectedVersion: body.expectedVersion,
        actor: { type: "user", userId },
        beforeCommit: async (txRaw: unknown) => {
          const tx = txRaw as Db;
          const [live] = await tx
            .select({ status: drAgentOutputs.status })
            .from(drAgentOutputs)
            .where(eq(drAgentOutputs.id, output.id))
            .for("update");
          if (live?.status !== "proposed") throw conflict("The proposal changed; reload and review again");

          // Only fields the reviewer actually changed become overrides; approve covers every field, reject only the duplicate link.
          const diffs: Array<[string, unknown, unknown]> = [];
          const check = (field: string, a: unknown, b: unknown) => {
            if (!same(a, b)) diffs.push([field, a, b]);
          };
          if (body.decision === "approve") {
            check("classification", agent.classification, final.classification);
            check("priority", agent.priority, final.priority);
            check("difficulty", agent.difficulty, final.difficulty);
            check("requiresHuman", agent.requiresHuman, final.requiresHuman);
            check("requiresHumanReasons", agent.requiresHumanReasons, final.requiresHumanReasons);
          }
          if (body.decision !== "request_changes") check("duplicateOf", keyOf(agent.duplicateOfCaseId), duplicateKey);
          for (const [field, a, b] of diffs) {
            await tx.insert(drOverrides).values({ companyId, caseId, outputId: output.id, stageKey: "triage", field, agentValue: a ?? null, finalValue: b ?? null, actorUserId: userId });
            overridden.push(field);
          }
          await tx
            .update(drAgentOutputs)
            .set({
              status: body.decision === "approve" ? (overridden.length ? "overridden" : "accepted") : "superseded",
              decidedAt: new Date(),
              decidedByUserId: userId,
            })
            .where(eq(drAgentOutputs.id, output.id));
          if (body.decision === "approve") {
            await tx
              .update(drRequests)
              .set({
                classification: final.classification,
                priority: final.priority,
                difficulty: final.difficulty,
                requiresHuman: final.requiresHuman,
                requiresHumanReasons: final.requiresHumanReasons,
                duplicateOfCaseId: null,
                updatedAt: new Date(),
              })
              .where(and(eq(drRequests.caseId, caseId), eq(drRequests.companyId, companyId)));
          } else if (body.decision === "reject" && final.duplicateOfCaseId) {
            await tx
              .update(drRequests)
              .set({ duplicateOfCaseId: final.duplicateOfCaseId, updatedAt: new Date() })
              .where(and(eq(drRequests.caseId, caseId), eq(drRequests.companyId, companyId)));
          }
          await logActivity(tx, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "triage.decided",
            entityType: "pipeline_case",
            entityId: caseId,
            details: { decision: body.decision, outputId: output.id, overriddenFields: overridden },
          });
        },
      });
    } catch (err) {
      // Another reviewer got in between our checks and the core transaction: report that as a conflict, not as
      // the core's "not in a review stage" validation error.
      const now = await loadReviewable(companyId, caseId);
      if (!now || now.stage_key !== "triage_review") throw conflict("This request is no longer waiting for triage review");
      throw err;
    }
    return { ok: true as const, decision: body.decision, overriddenFields: overridden };
  }

  return { queue, detail, decide };
}
