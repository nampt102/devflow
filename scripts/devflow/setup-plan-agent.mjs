#!/usr/bin/env node
// Creates or updates the Planner agent ("DevFlow Planner") of a company so it is exactly what DevFlow expects. Safe to
// run again: run it after every upgrade that changes the Tech Plan prompt or the deny rules, or when the Tech Plan
// worker reports `agent_prompt_outdated` or `agent_instance_not_denied`. It reuses the Anthropic key secret of BA.
//
//   node scripts/devflow/setup-plan-agent.mjs --company <companyId>
//
// Env: see scripts/devflow/lib/setup-stage-agent.mjs.
import { setupStageAgent } from "./lib/setup-stage-agent.mjs";

await setupStageAgent({
  script: "setup-plan-agent.mjs",
  label: "Planner",
  setupPath: "plan-agent",
  title: "Tech Plan (DevFlow)",
  capabilities: "Writes the draft technical plan for a request from its approved BA spec and code. Read-only; a person reviews every plan.",
});
