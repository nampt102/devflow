import { and, desc, eq, sql } from "drizzle-orm";
import { drAgentOutputs, type Db } from "@paperclipai/db";

// "Since last round" on the review screens (openspec change redesign-review-queues, D7): when a proposal comes back after
// request_changes, the reviewer sees why it was sent back and what changed in the structured fields. Read-only.

type Row = Record<string, any>;

export interface PreviousRound {
  reason: string;
  decidedAt: string;
  decidedBy: string | null;
  /** the review stage that sent it back (qa_signoff for Dev work QA returned) */
  fromStage: string | null;
  previousSummary: string | null;
  changes: Array<{ field: string; before: string; after: string }>;
}

const scalar = (k: string) => (d: Row) => (d[k] == null ? "" : String(d[k]));
const count = (k: string) => (d: Row) => String(Array.isArray(d[k]) ? d[k].length : 0);
const failedChecks = (d: Row) => String((Array.isArray(d.checks) ? d.checks : []).filter((c: Row) => !c.passed).length);

const SPEC: Record<string, { fields: Array<[string, (d: Row) => string]>; perId?: [list: string, value: string] }> = {
  triage: { fields: [["Classification", scalar("classification")], ["Priority", scalar("priority")], ["Difficulty", scalar("difficulty")], ["Needs a developer", (d) => (d.requiresHuman ? "yes" : "no")]] },
  ba_spec: { fields: [["Acceptance criteria", count("acceptanceCriteria")], ["In scope", count("inScope")], ["Out of scope", count("outOfScope")], ["Open questions", count("openQuestions")], ["Confidence", scalar("confidence")]] },
  tech_plan: { fields: [["Tasks", count("tasks")], ["Test plan", count("testPlan")], ["Risks", count("risks")], ["Open questions", count("openQuestions")], ["Confidence", scalar("confidence")]] },
  dev: { fields: [["Failed commands", failedChecks], ["Confidence", scalar("confidence")]], perId: ["tasks", "status"] },
  qa: {
    fields: [["Recommendation", (d) => String(d.recommendation?.value ?? "")], ["High issues", (d) => String((Array.isArray(d.issues) ? d.issues : []).filter((i: Row) => i.severity === "high").length)], ["Failed commands", failedChecks]],
    perId: ["criteria", "verdict"],
  },
};

/** Old → new for the fields a reviewer checks first; only the ones that differ. */
export function roundChanges(stageKey: string, before: Row, after: Row): PreviousRound["changes"] {
  const spec = SPEC[stageKey];
  if (!spec) return [];
  const out: PreviousRound["changes"] = [];
  for (const [field, pick] of spec.fields) {
    const b = pick(before);
    const a = pick(after);
    if (b !== a) out.push({ field, before: b, after: a });
  }
  if (spec.perId) {
    const [list, value] = spec.perId;
    const map = (d: Row) => new Map<string, string>((Array.isArray(d[list]) ? d[list] : []).map((x: Row) => [String(x.id), String(x[value] ?? "")]));
    const b = map(before);
    const a = map(after);
    for (const id of [...new Set([...b.keys(), ...a.keys()])]) {
      if (b.get(id) !== a.get(id)) out.push({ field: id, before: b.get(id) ?? "", after: a.get(id) ?? "" });
    }
  }
  return out;
}

/**
 * The round before the current proposal of `stageKey`: the newest superseded output and the request_changes decision made
 * after it existed (an older one belongs to an earlier round or stage). Null when the proposal is a first round.
 */
export async function loadPreviousRound(db: Db, companyId: string, caseId: string, stageKey: string, current: Row): Promise<PreviousRound | null> {
  const [prev] = await db
    .select({ data: drAgentOutputs.data, createdAt: drAgentOutputs.createdAt })
    .from(drAgentOutputs)
    .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, stageKey), eq(drAgentOutputs.status, "superseded")))
    .orderBy(desc(drAgentOutputs.createdAt))
    .limit(1);
  if (!prev) return null;
  const [ev] = (await db.execute(sql`
    select e.payload->>'reason' as reason, e.created_at, u.name as by_name, st.key as from_stage
    from pipeline_case_events e
    left join "user" u on u.id = e.actor_user_id
    left join pipeline_stages st on st.id = e.from_stage_id
    where e.company_id = ${companyId} and e.case_id = ${caseId} and e.type = 'review_decided' and e.payload->>'decision' = 'request_changes'
      and e.created_at >= ${prev.createdAt.toISOString()}::timestamptz
    order by e.created_at desc, e.id desc limit 1`)) as unknown as Row[];
  if (!ev?.reason?.trim()) return null;
  const before = (prev.data ?? {}) as Row;
  return {
    reason: ev.reason,
    decidedAt: new Date(ev.created_at).toISOString(),
    decidedBy: ev.by_name ?? null,
    fromStage: ev.from_stage ?? null,
    previousSummary: typeof before.summary === "string" ? before.summary : null,
    changes: roundChanges(stageKey, before, current),
  };
}
