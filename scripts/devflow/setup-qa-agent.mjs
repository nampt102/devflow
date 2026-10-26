#!/usr/bin/env node
// Creates or updates the QA agent ("DevFlow QA") of a company so it is exactly what DevFlow expects: it works on the runner only
// (Paperclip SSH environment from setup-dev-runner.mjs), with the tools the prompt describes, a spend limit per run and the
// current instructions. It reads and runs the pull request's branch and never pushes. Safe to run again: run it after every
// upgrade that changes the QA prompt, or when the QA worker reports `agent_prompt_outdated`, `agent_not_on_runner` or
// `agent_tools_changed`. Run scripts/devflow/setup-dev-runner.mjs for the company first. It reuses the Anthropic key secret of BA.
//
//   node scripts/devflow/setup-qa-agent.mjs --company <companyId>
//
// Env: see scripts/devflow/lib/setup-stage-agent.mjs.
import { setupStageAgent } from "./lib/setup-stage-agent.mjs";

await setupStageAgent({
  script: "setup-qa-agent.mjs",
  label: "QA",
  setupPath: "qa-agent",
  title: "QA (DevFlow)",
  capabilities: "Checks the pull request's branch against the approved acceptance criteria on the runner and reports evidence. It changes nothing and never pushes; a person signs off.",
});
