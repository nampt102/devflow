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

/**
 * What QA found, as text for the Dev agent after a sign-off sent the work back: the criteria that failed or could not be
 * checked (with their text and the evidence) and the high and medium issues. Data written by an agent: it goes in the feedback
 * block of request.md, between the boundary lines.
 */
export function qaFindingsText(qaData: Row): string {
  const text: Row = qaData.criteriaText && typeof qaData.criteriaText === "object" ? qaData.criteriaText : {};
  const criteria: Row[] = Array.isArray(qaData.criteria) ? qaData.criteria : [];
  const issues: Row[] = Array.isArray(qaData.issues) ? qaData.issues : [];
  const parts = [
    ...criteria.filter((c) => c.verdict === "fail" || c.verdict === "not_verified").map((c) => `${str(c.id, 10)} (${str(c.verdict, 20)}) ${str(text[c.id], 300)}: ${str(c.evidence, 400)}`),
    ...issues.filter((i) => i.severity === "high" || i.severity === "medium").map((i) => `issue [${str(i.severity, 10)}] ${str(i.title, 200)}: ${str(i.steps, 300)}`),
  ];
  return parts.length ? `QA found: ${parts.join(" | ")}`.slice(0, 2000) : "";
}
