import { z } from "zod";
import { AgentOutputError, describeIssues, extractJsonObject } from "../agent-stage/output.js";

// Output contract of the Dev agent (openspec/changes/add-dev-stage, design D6).
// Strict on purpose: unknown keys are rejected, not ignored. DevFlow adds the facts the agent cannot vouch for
// (branch, commits, diff size, pull request) itself after it has checked the diff; they are not part of this contract.

const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax: number) => z.array(line(itemMax)).max(max);

export const DEV_TASK_STATUSES = ["done", "partial", "skipped"] as const;

export const devOutputSchema = z.strictObject({
  summary: line(800),
  tasks: z
    .array(z.strictObject({ id: z.string().regex(/^T[1-9][0-9]?$/), status: z.enum(DEV_TASK_STATUSES), notes: line(500) }))
    .min(1)
    .max(30),
  // the commands the agent ran to check its work and what they said; an empty tail is a command that printed nothing
  checks: z
    .array(z.strictObject({ system: line(64), command: line(500), passed: z.boolean(), outputTail: z.string().trim().max(2000) }))
    .max(20),
  openQuestions: list(10, 300),
  risks: list(10, 300),
  confidence: z.enum(["low", "medium", "high"]),
});
export type DevOutput = z.infer<typeof devOutputSchema>;

/**
 * Checks the report against what DevFlow asked for: every task of the request is reported exactly once and nothing
 * else, and checks name only systems the agent worked on. Messages carry no agent text.
 */
export function checkDevOutput(out: DevOutput, taskIds: readonly string[], systemKeys: readonly string[]): void {
  const asked = new Set(taskIds);
  const seen = new Set<string>();
  for (const t of out.tasks) {
    if (!asked.has(t.id)) throw new AgentOutputError("tasks names an id that is not in the approved plan for this request");
    if (seen.has(t.id)) throw new AgentOutputError("tasks has a duplicate id");
    seen.add(t.id);
  }
  if (seen.size !== asked.size) throw new AgentOutputError("tasks must report every task of the plan that was given to you");
  const systems = new Set(systemKeys);
  if (out.checks.some((c) => !systems.has(c.system))) throw new AgentOutputError("a check names a system that was not given to you");
}

/** Parse the agent's text. `taskIds` and `systemKeys` are what request.md listed. */
export function parseDevOutput(text: string, taskIds: readonly string[], systemKeys: readonly string[]): DevOutput {
  const parsed = devOutputSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) throw new AgentOutputError(`output does not match the schema (${describeIssues(parsed.error.issues)})`);
  checkDevOutput(parsed.data, taskIds, systemKeys);
  return parsed.data;
}
