import type { TriageDecision, TriageDetail, TriageFinalPatch, TriageQueueItem } from "../api/devflowTriage";

// Pure helpers for the DevFlow triage review screen.

export const CLASSIFICATIONS = ["bug", "feature", "request"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export const HUMAN_REASON_LABELS: Record<string, string> = {
  sqlserver_migration: "SQL Server migration",
  production_change: "Production change",
  data_fix: "Data fix",
  security_or_permission: "Security or permissions",
  external_integration: "External integration",
  finance_or_payroll_data: "Finance or payroll data",
};
export const HUMAN_REASONS = Object.keys(HUMAN_REASON_LABELS);

export type QueueFilter = "all" | "needs_human" | "possible_duplicate";

export interface TriageDraft {
  classification: string;
  priority: string;
  difficulty: string;
  requiresHuman: boolean;
  requiresHumanReasons: string[];
  duplicateOfCaseId: string | null;
}

/** The editable form starts from the agent's proposal; the first named candidate is the proposed duplicate. */
export function draftFromDetail(detail: TriageDetail): TriageDraft {
  const named = detail.candidates.find((c) => c.namedByModel);
  return {
    classification: detail.proposal.classification,
    priority: detail.proposal.priority,
    difficulty: detail.proposal.difficulty,
    requiresHuman: detail.proposal.requiresHuman,
    requiresHumanReasons: [...detail.proposal.requiresHumanReasons].sort(),
    duplicateOfCaseId: named?.caseId ?? null,
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Fields where the draft differs from the proposal (what would become overrides). */
export function changedFields(base: TriageDraft, draft: TriageDraft): Array<keyof TriageDraft> {
  const out: Array<keyof TriageDraft> = [];
  if (draft.classification !== base.classification) out.push("classification");
  if (draft.priority !== base.priority) out.push("priority");
  if (draft.difficulty !== base.difficulty) out.push("difficulty");
  if (draft.requiresHuman !== base.requiresHuman) out.push("requiresHuman");
  if (!sameList(draft.requiresHumanReasons, base.requiresHumanReasons)) out.push("requiresHumanReasons");
  if (draft.duplicateOfCaseId !== base.duplicateOfCaseId) out.push("duplicateOfCaseId");
  return out;
}

/** Only the changed fields go to the server; an untouched form sends nothing and means "accept the proposal". */
export function finalPatch(base: TriageDraft, draft: TriageDraft): TriageFinalPatch | undefined {
  const fields = changedFields(base, draft);
  if (!fields.length) return undefined;
  const patch: Record<string, unknown> = {};
  for (const f of fields) patch[f] = draft[f];
  return patch as TriageFinalPatch;
}

/** Why a decision cannot be sent yet (null when it can). */
export function decisionBlocker(decision: TriageDecision, draft: TriageDraft, reason: string): string | null {
  if (!draft.requiresHuman && draft.requiresHumanReasons.length) return "Choose \"Needs a developer\" or clear the reasons.";
  if ((decision === "request_changes" || (decision === "reject" && !draft.duplicateOfCaseId)) && !reason.trim()) {
    return "A reason is required.";
  }
  if (decision === "approve" && draft.duplicateOfCaseId) return "Approving a request marked as duplicate is not allowed. Reject it as a duplicate instead.";
  return null;
}

export function filterQueue(items: TriageQueueItem[], filter: QueueFilter): TriageQueueItem[] {
  if (filter === "needs_human") return items.filter((i) => i.proposal.requiresHuman);
  if (filter === "possible_duplicate") return items.filter((i) => i.proposal.duplicateCandidates > 0);
  return items;
}

export function ageLabel(createdAt: string | Date, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export const scoreLabel = (value: number | null) => (value === null ? "-" : value.toFixed(2));

export const pct = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);

/** 45 s, 12 min, 3.5 h, 2 d: the unit that reads best. */
export function durationLabel(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round(hours / 24)} d`;
}

export const FIELD_LABELS: Record<string, string> = {
  classification: "Type",
  priority: "Priority",
  difficulty: "Difficulty",
  requiresHuman: "Needs a developer",
  requiresHumanReasons: "Developer reasons",
  duplicateOf: "Duplicate of",
};

export type QueueOrder = "newest" | "oldest";

/** Order by when the proposal arrived. Ties keep the server's order. */
export function sortQueue(items: TriageQueueItem[], order: QueueOrder): TriageQueueItem[] {
  const at = (i: TriageQueueItem) => new Date(i.proposedAt).getTime();
  return [...items].sort((a, b) => (order === "newest" ? at(b) - at(a) : at(a) - at(b)));
}

/** "New" = arrived after the reviewer last left the page. Unknown last visit (first time) marks nothing. */
export const isNewSince = (proposedAt: string, seenAt: number | null): boolean => seenAt !== null && new Date(proposedAt).getTime() > seenAt;

const seenKey = (companyId: string) => `devflow.triage.seenAt:${companyId}`;
const ORDER_KEY = "devflow.triage.order";

export function readSeenAt(companyId: string): number | null {
  try {
    const v = Number(localStorage.getItem(seenKey(companyId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function writeSeenAt(companyId: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(seenKey(companyId), String(at));
  } catch {
    /* storage can be blocked; the labels just do not persist */
  }
}
export function readOrder(): QueueOrder {
  try {
    return localStorage.getItem(ORDER_KEY) === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}
export function writeOrder(order: QueueOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, order);
  } catch {
    /* see above */
  }
}
