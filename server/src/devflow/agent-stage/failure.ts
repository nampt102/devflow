export type StageFailureKind =
  | "no_agent"
  | "agent_not_runnable"
  | "agent_wrong_adapter"
  | "agent_wrong_engine"
  | "agent_wrong_workspace"
  | "agent_no_instructions"
  | "agent_extra_capability"
  | "agent_tools_not_read_only"
  | "agent_instance_not_denied"
  | "agent_no_budget"
  | "agent_prompt_outdated"
  | "system_missing_token"
  | "no_approved_spec"
  | "clone_failed"
  | "clone_timeout"
  | "workspace_failed"
  | "run_failed"
  | "run_timeout"
  | "wake_skipped"
  | "budget_exhausted"
  | "invalid_output"
  | "transition_failed";

/** Why a stage run did not produce a proposal. The kind is all that is logged: never request text or agent output. */
export class StageFailure extends Error {
  constructor(readonly kind: StageFailureKind) {
    super(`stage ${kind}`);
    this.name = "StageFailure";
  }
}

/** Problems with the setup, not with the request: nothing was spent, so they are retried calmly and never given up on. */
export const CONFIG_KINDS: ReadonlySet<StageFailureKind> = new Set<StageFailureKind>([
  "no_agent",
  "agent_not_runnable",
  "agent_wrong_adapter",
  "agent_wrong_engine",
  "agent_wrong_workspace",
  "agent_no_instructions",
  "agent_extra_capability",
  "agent_tools_not_read_only",
  "agent_instance_not_denied",
  "agent_no_budget",
  "agent_prompt_outdated",
  "system_missing_token",
  "no_approved_spec",
]);
