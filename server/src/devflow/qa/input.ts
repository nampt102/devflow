import { sanitizeUntrusted } from "../triage/triage-service.js";

// What the QA agent is told to check: the acceptance criteria a reviewer approved in the BA spec (numbered by DevFlow, so the
// agent cannot invent or renumber them), the approved test plan, and what the Dev agent reported. Everything in it is data
// written by requesters, reviewers or agents.

type Row = Record<string, any>;
const str = (v: unknown, max: number) => sanitizeUntrusted(String(v ?? ""), max).replace(/\s+/g, " ").trim();
const REPORT_CAP = 6000;

/** The approved spec's acceptance criteria as AC1, AC2, ... in their order. */
export function numberedCriteria(spec: Row): Array<{ id: string; text: string }> {
  const list: unknown[] = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : [];
  return list
    .map((c) => str(c, 600))
    .filter(Boolean)
    .slice(0, 30)
    .map((text, i) => ({ id: `AC${i + 1}`, text }));
}

/** The approved plan's test plan items. */
export function testPlanItems(plan: Row): string[] {
  const list: unknown[] = Array.isArray(plan.testPlan) ? plan.testPlan : [];
  return list.map((t) => str(t, 400)).filter(Boolean).slice(0, 20);
}

/** The approved Dev proposal (`data.approved` of the accepted dev output) as plain text: claims for the QA agent to verify. */
export function devReportText(approvedDev: Row): string {
  const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);
  const tasks: Row[] = Array.isArray(approvedDev.tasks) ? approvedDev.tasks : [];
  const checks: Row[] = Array.isArray(approvedDev.checks) ? approvedDev.checks : [];
  return [
    `Summary: ${str(approvedDev.summary, 800)}`,
    ...section("Tasks", tasks.map((t) => `${str(t.id, 10)} (${str(t.status, 20)}): ${str(t.notes, 500)}`)),
    ...section("Commands the developer says it ran", checks.map((c) => `${c.passed === true ? "passed" : "failed"}: ${str(c.command, 300)} (${str(c.system, 64)})`)),
  ]
    .join("\n")
    .slice(0, REPORT_CAP);
}
