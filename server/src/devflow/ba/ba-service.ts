import type { Db } from "@paperclipai/db";
import { StageFailure, type StageFailureKind } from "../agent-stage/failure.js";
import { stageService, type StageDefinition, type StageServiceDeps } from "../agent-stage/run-loop.js";
import { PROMPT_HASH, PROMPT_VERSION, buildRequestFile } from "../prompts/ba.v1.js";
import { unsafeBaAgentReason } from "./agent.js";
import { baCommentMarkdown, parseBaOutput, type BaOutput } from "./schema.js";

// BA Spec for one request (openspec/changes/add-ba-spec-stage, design D1 to D5) on the shared stage run loop:
// prepare the workspace, run the agent through Paperclip, check what it said, store it as a proposal and send the
// request to BA review.

export { StageFailure as BaFailure };
export type BaFailureKind = StageFailureKind;
export type BaServiceDeps = StageServiceDeps;

export const BA_STAGE = "ba_spec";
export const BA_REVIEW_STAGE = "ba_review";

export const BA_STAGE_DEFINITION: StageDefinition<BaOutput, null> = {
  role: "ba",
  stageKey: BA_STAGE,
  reviewStageKey: BA_REVIEW_STAGE,
  actorId: "devflow-ba",
  prompt: { version: PROMPT_VERSION, hash: PROMPT_HASH },
  artifact: "spec",
  proposedReason: "ba_spec_proposed",
  unsafeReason: (agent, root) => unsafeBaAgentReason(agent, root),
  loadContext: async () => null,
  buildRequest: (input) => buildRequestFile(input),
  parse: parseBaOutput,
  comment: baCommentMarkdown,
};

export function baService(db: Db, deps: BaServiceDeps) {
  const service = stageService(db, BA_STAGE_DEFINITION, deps);
  return { ...service, baCase: service.runCase };
}
