import type { ApproveBlocker, CodeDecision, CodeDecisionResult, CodeDetail, CodeRepo, CodeTaskStatus } from "../api/devflowCode";

// Pure helpers for the DevFlow Code review page. The server enforces the same rules; these only tell the reviewer
// what is wrong before they click.

export const TASK_STATUS_LABELS: Record<CodeTaskStatus, string> = { done: "Done", partial: "Partly done", skipped: "Skipped" };

/** Why DevFlow did not push a diff, in words a reviewer can act on. */
export const BLOCKED_LABELS: Record<string, string> = {
  forbidden_paths: "Changed files that agents may not change (CI, deployment, .env, keys)",
  diff_too_large: "The change is larger than the limit",
  binary_too_large: "A binary file is larger than 1 MB",
  submodule_change: "The change touches a submodule",
  wrong_branch: "The commits are not on the request's branch",
  history_rewritten: "The agent rewrote git history",
};

export const CODE_FAILURE_LABELS: Record<string, string> = {
  "agent.dev_failed": "Run failed",
  "agent.dev_gave_up": "Gave up",
  "agent.dev_budget_paused": "Paused: daily spend cap",
};

const APPROVE_BLOCKERS: Record<Exclude<ApproveBlocker, null>, string> = {
  no_pull_request: "There is no pull request to approve. Send the request back or reject it.",
  blocked_diff: "DevFlow did not push this work because a check refused it. Send it back or reject it.",
};

/** Why a decision button is off, or null. `access` (the role check) is handled by the caller. */
export function codeDecisionBlocker(decision: CodeDecision, reason: string, approveBlocker: ApproveBlocker): string | null {
  if (decision === "approve") return approveBlocker ? APPROVE_BLOCKERS[approveBlocker] : null;
  return reason.trim() ? null : "Write a reason first.";
}

/** Only links to GitHub are opened from this page, whatever the data says. */
export function safeGithubUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]*)?$/.test(url) ? url : null;
}

export type RepoOutcome =
  | { kind: "pull_request"; url: string | null; number: number; stats: string; warning: boolean }
  | { kind: "blocked"; label: string; paths: string[] }
  | { kind: "no_changes" };

export function repoOutcome(repo: CodeRepo): RepoOutcome {
  if (repo.blocked) return { kind: "blocked", label: BLOCKED_LABELS[repo.blocked.kind] ?? repo.blocked.kind, paths: repo.blocked.paths.slice(0, 20) };
  if (repo.prNumber !== undefined && repo.prUrl) {
    const files = repo.filesChanged ?? 0;
    return {
      kind: "pull_request",
      url: safeGithubUrl(repo.prUrl),
      number: repo.prNumber,
      stats: `${files} file${files === 1 ? "" : "s"}, +${repo.additions ?? 0} -${repo.deletions ?? 0}, ${repo.commits ?? 0} commit${repo.commits === 1 ? "" : "s"}`,
      warning: repo.unprotectedWarning === true,
    };
  }
  return { kind: "no_changes" };
}

export type TaskRow = { id: string; title: string; size: string; system: string | null; status: CodeTaskStatus | "not_reported"; notes: string | null };

/** The approved plan's tasks next to what the agent says it did; a task it did not report is shown as such. */
export function compareTasks(planTasks: CodeDetail["planTasks"], reported: CodeDetail["report"]["tasks"]): TaskRow[] {
  const byId = new Map(reported.map((t) => [t.id, t]));
  const rows: TaskRow[] = planTasks.map((p) => {
    const r = byId.get(p.id);
    return { id: p.id, title: p.title, size: p.size, system: p.system, status: r?.status ?? "not_reported", notes: r?.notes ?? null };
  });
  // a reported task the plan does not have cannot happen (the server checks), but is shown rather than dropped
  for (const r of reported) if (!planTasks.some((p) => p.id === r.id)) rows.push({ id: r.id, title: r.id, size: "?", system: null, status: r.status, notes: r.notes });
  return rows;
}

/** One line for the toast after a decision, naming any pull request that still has to be closed by hand. */
export function decisionSummary(caseKey: string, result: CodeDecisionResult): { title: string; body?: string; tone: "success" | "warn" } {
  const verb = result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back";
  const left = result.closedPullRequests.filter((p) => !p.closed);
  if (left.length > 0) {
    return { title: `${caseKey} ${verb}`, body: `Close on GitHub: ${left.map((p) => `#${p.prNumber} (${p.system})`).join(", ")}. DevFlow could not close ${left.length === 1 ? "it" : "them"}.`, tone: "warn" };
  }
  const closed = result.closedPullRequests.length;
  return { title: `${caseKey} ${verb}`, body: closed ? `${closed} pull request${closed === 1 ? "" : "s"} closed.` : undefined, tone: "success" };
}

const seenKey = (companyId: string) => `devflow-code-review-seen:${companyId}`;

/** When the reviewer last left the page: anything newer is labelled "New". */
export function readCodeSeenAt(companyId: string): number | null {
  try {
    const v = Number(localStorage.getItem(seenKey(companyId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function writeCodeSeenAt(companyId: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(seenKey(companyId), String(at));
  } catch {
    /* storage can be blocked; the labels just do not persist */
  }
}
