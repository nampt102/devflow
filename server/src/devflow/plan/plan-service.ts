import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { drAgentOutputs, type Db } from "@paperclipai/db";
import { StageFailure } from "../agent-stage/failure.js";
import { stageService, type StageDefinition, type StageServiceDeps } from "../agent-stage/run-loop.js";
import { BA_STAGE } from "../ba/ba-service.js";
import { PROMPT_HASH, PROMPT_VERSION, buildRequestFile } from "../prompts/plan.v1.js";
import { sanitizeUntrusted } from "../triage/triage-service.js";
import { unsafePlanAgentReason } from "./agent.js";
import { parsePlanOutput, planCommentMarkdown, type PlanOutput } from "./schema.js";

// Tech Plan for one request (openspec/changes/add-tech-plan-stage, design D4 and D5) on the shared stage run loop.
// The input is the BA spec a reviewer approved (`data.approved` of the accepted ba_spec proposal), not the agent's draft.

export const PLAN_STAGE = "tech_plan";
export const PLAN_REVIEW_STAGE = "plan_review";

const SPEC_CAP = 12_000;
type Row = Record<string, any>;
const str = (v: unknown, max = 1000) => (typeof v === "string" ? sanitizeUntrusted(v, max).replace(/\s+/g, " ").trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 600)).filter(Boolean) : []);

/** The approved spec as plain text for request.md. Everything in it is data (requester and agent words). */
export function approvedSpecText(spec: Row): string {
  const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);
  const stories = Array.isArray(spec.userStories) ? spec.userStories.map((s: Row) => `As ${str(s?.asA, 200)}, I want ${str(s?.iWant, 300)}, so that ${str(s?.soThat, 300)}`) : [];
  const areas = Array.isArray(spec.affectedAreas)
    ? spec.affectedAreas.map((a: Row) => `${str(a?.system, 64)}: ${str(a?.path, 300)}${typeof a?.line === "number" ? `:${a.line}` : ""} (${str(a?.why, 300)})`)
    : [];
  return [
    `Summary: ${str(spec.summary, 800)}`,
    `Business goal: ${str(spec.businessGoal, 800)}`,
    ...section("In scope", strs(spec.inScope)),
    ...section("Out of scope", strs(spec.outOfScope)),
    ...section("User stories", stories),
    ...section("Acceptance criteria", strs(spec.acceptanceCriteria)),
    ...section("Affected areas the BA cited (system: path:line)", areas),
    ...section("Data changes", strs(spec.dataChanges)),
    ...section("Risks", strs(spec.risks)),
    ...section("Open questions", strs(spec.openQuestions)),
  ]
    .join("\n")
    .slice(0, SPEC_CAP);
}

export function planStageDefinition(db: Db): StageDefinition<PlanOutput, string> {
  return {
    role: "plan",
    stageKey: PLAN_STAGE,
    reviewStageKey: PLAN_REVIEW_STAGE,
    actorId: "devflow-plan",
    prompt: { version: PROMPT_VERSION, hash: PROMPT_HASH },
    artifact: "plan",
    proposedReason: "tech_plan_proposed",
    unsafeReason: (agent, root) => unsafePlanAgentReason(agent, root),
    async loadContext(companyId, caseId) {
      const [spec] = await db
        .select({ data: drAgentOutputs.data })
        .from(drAgentOutputs)
        .where(
          and(
            eq(drAgentOutputs.companyId, companyId),
            eq(drAgentOutputs.caseId, caseId),
            eq(drAgentOutputs.stageKey, BA_STAGE),
            inArray(drAgentOutputs.status, ["accepted", "overridden"]),
            isNotNull(drAgentOutputs.decidedAt),
          ),
        )
        .orderBy(desc(drAgentOutputs.decidedAt))
        .limit(1);
      const approved = (spec?.data as Row | undefined)?.approved;
      if (!approved || typeof approved !== "object") throw new StageFailure("no_approved_spec");
      return approvedSpecText(approved as Row);
    },
    buildRequest: (input, approvedSpec) => buildRequestFile({ ...input, approvedSpec }),
    parse: parsePlanOutput,
    comment: planCommentMarkdown,
  };
}

export function planService(db: Db, deps: StageServiceDeps) {
  return stageService(db, planStageDefinition(db), deps);
}
