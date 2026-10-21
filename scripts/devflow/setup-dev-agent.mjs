#!/usr/bin/env node
// Creates or updates the Dev agent ("DevFlow Dev") of a company so it is exactly what DevFlow expects: it works on
// the runner only (Paperclip SSH environment from setup-dev-runner.mjs), with the tools the prompt describes, a spend
// limit per run and the current instructions. Safe to run again: run it after every upgrade that changes the Dev
// prompt, or when the Dev worker reports `agent_prompt_outdated`, `agent_not_on_runner` or `agent_tools_changed`.
// Run scripts/devflow/setup-dev-runner.mjs for the company first. It reuses the Anthropic key secret of BA.
//
//   node scripts/devflow/setup-dev-agent.mjs --company <companyId>
//
// Env: see scripts/devflow/lib/setup-stage-agent.mjs.
import { setupStageAgent } from "./lib/setup-stage-agent.mjs";

await setupStageAgent({
  script: "setup-dev-agent.mjs",
  label: "Dev",
  setupPath: "dev-agent",
  title: "Developer (DevFlow)",
  capabilities: "Implements the approved technical plan on its own branch on the runner and checks it. A person reviews every pull request; it never merges.",
});
