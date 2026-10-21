#!/usr/bin/env node
// Creates or updates the BA agent of a company so it is exactly what DevFlow expects. Safe to run again: run it after
// every upgrade that changes the BA prompt or the deny rules, or when the BA worker reports `agent_prompt_outdated`
// or `agent_instance_not_denied`.
//
//   node scripts/devflow/setup-ba-agent.mjs --company <companyId>
//
// Env: see scripts/devflow/lib/setup-stage-agent.mjs.
import { setupStageAgent } from "./lib/setup-stage-agent.mjs";

await setupStageAgent({
  script: "setup-ba-agent.mjs",
  label: "BA",
  setupPath: "ba-agent",
  title: "BA Spec (DevFlow)",
  capabilities: "Writes the draft BA spec for a request from its business documents and code. Read-only; a person reviews every spec.",
});
