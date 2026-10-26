import type { QaDecision, QaHow, QaVerdict, QaWarning } from "../api/devflowQa";

// Pure helpers for the DevFlow QA sign-off page. The server enforces the same rules; these only tell the reviewer what is
// wrong before they click and explain the codes DevFlow stores.

export const VERDICT_LABELS: Record<QaVerdict, string> = { pass: "Pass", fail: "Fail", not_verified: "Not verified" };
export const HOW_LABELS: Record<QaHow, string> = { automated: "ran a test or script", code_reading: "read the code only", manual: "needs a person" };
export const SEVERITY_LABELS = { high: "High", medium: "Medium", low: "Low" } as const;

export const WARNING_LABELS: Record<QaWarning, string> = {
  qa_modified_branch: "The QA agent committed to the branch (the commit was discarded and nothing was pushed). Check why before trusting this report.",
  branch_moved: "The branch has new commits since the code was approved; QA checked the newer head.",
};

export const QA_FAILURE_LABELS: Record<string, string> = {
  "agent.qa_failed": "Run failed",
  "agent.qa_gave_up": "Gave up",
  "agent.qa_budget_paused": "Paused: daily spend cap",
};

/** "criteria_failed:AC2" becomes "Failed: AC2"; an unknown code is shown as it is. */
export function reasonLabel(code: string): string {
  const [kind, rest] = code.split(":");
  switch (kind) {
    case "criteria_failed":
      return `Failed: ${rest}`;
    case "criteria_not_verified":
      return `Not verified: ${rest}`;
    case "checks_failed":
      return "A command did not pass";
    case "high_issue":
      return "A high-severity issue was found";
    case "qa_modified_branch":
      return "The agent changed the branch";
    default:
      return code;
  }
}

export function recommendationText(value: "approve" | "changes" | null): string {
  return value === "approve" ? "DevFlow recommends approving" : value === "changes" ? "DevFlow recommends sending it back" : "No recommendation";
}

/** Why a decision button is off, or null. `access` (the role check) is handled by the caller. Approving is never blocked: the person decides. */
export function qaDecisionBlocker(decision: QaDecision, reason: string): string | null {
  if (decision === "approve") return null;
  return reason.trim() ? null : "Write a reason first.";
}

/** "3 of 5 criteria pass" for the queue, with failed and unverified counts when there are any. */
export function criteriaSummary(c: { total: number; pass: number; fail: number; notVerified: number }): string {
  const rest = [c.fail ? `${c.fail} failed` : "", c.notVerified ? `${c.notVerified} not verified` : ""].filter(Boolean).join(", ");
  return `${c.pass} of ${c.total} criteria pass${rest ? ` (${rest})` : ""}`;
}

/** A short share like "25%" for the agreement metric; "no data" without decisions. */
export function againstRateText(rate: number | null): string {
  return rate === null ? "no decisions yet" : `${Math.round(rate * 100)}%`;
}

const seenKey = (companyId: string) => `devflow-qa-signoff-seen:${companyId}`;

/** When the reviewer last left the page: anything newer is labelled "New". */
export function readQaSeenAt(companyId: string): number | null {
  try {
    const v = Number(localStorage.getItem(seenKey(companyId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function writeQaSeenAt(companyId: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(seenKey(companyId), String(at));
  } catch {
    /* storage can be blocked; the labels just do not persist */
  }
}
