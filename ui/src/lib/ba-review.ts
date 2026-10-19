import type { BaArea, BaDecision, BaDetail, BaEditable, BaStory } from "../api/devflowBa";

// Pure helpers for the DevFlow "BA review" page: the spec as text the reviewer can edit, what changed, and links
// to the code the agent cited.

export const LIST_FIELDS = ["inScope", "outOfScope", "acceptanceCriteria", "dataChanges", "risks", "openQuestions"] as const;
export type ListField = (typeof LIST_FIELDS)[number];

export const FIELD_LABELS: Record<keyof BaEditable, string> = {
  summary: "Summary",
  businessGoal: "Business goal",
  inScope: "In scope",
  outOfScope: "Out of scope",
  userStories: "User stories",
  acceptanceCriteria: "Acceptance criteria",
  dataChanges: "Data changes",
  risks: "Risks",
  openQuestions: "Open questions",
};

/** The editable fields as the reviewer sees them: text boxes, one item per line. */
export interface BaDraft {
  summary: string;
  businessGoal: string;
  inScope: string;
  outOfScope: string;
  userStories: string;
  acceptanceCriteria: string;
  dataChanges: string;
  risks: string;
  openQuestions: string;
}

const STORY_SEPARATOR = " | ";
export const storyToLine = (s: BaStory): string => [s.asA, s.iWant, s.soThat].join(STORY_SEPARATOR);

/** "A | B | C" per line; a line with another number of parts is not a story. */
export function parseStories(text: string): BaStory[] | null {
  const stories: BaStory[] = [];
  for (const line of splitLines(text)) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 3 || parts.some((p) => !p)) return null;
    stories.push({ asA: parts[0]!, iWant: parts[1]!, soThat: parts[2]! });
  }
  return stories;
}

export const splitLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function draftFromSpec(spec: BaEditable): BaDraft {
  return {
    summary: spec.summary,
    businessGoal: spec.businessGoal,
    inScope: spec.inScope.join("\n"),
    outOfScope: spec.outOfScope.join("\n"),
    userStories: spec.userStories.map(storyToLine).join("\n"),
    acceptanceCriteria: spec.acceptanceCriteria.join("\n"),
    dataChanges: spec.dataChanges.join("\n"),
    risks: spec.risks.join("\n"),
    openQuestions: spec.openQuestions.join("\n"),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The draft as the values the server stores (null when a story line is malformed). */
export function draftValues(draft: BaDraft): BaEditable | null {
  const stories = parseStories(draft.userStories);
  if (!stories) return null;
  return {
    summary: draft.summary.trim(),
    businessGoal: draft.businessGoal.trim(),
    inScope: splitLines(draft.inScope),
    outOfScope: splitLines(draft.outOfScope),
    userStories: stories,
    acceptanceCriteria: splitLines(draft.acceptanceCriteria),
    dataChanges: splitLines(draft.dataChanges),
    risks: splitLines(draft.risks),
    openQuestions: splitLines(draft.openQuestions),
  };
}

/** Fields whose text differs from the agent's. */
export function changedSpecFields(spec: BaEditable, draft: BaDraft): Array<keyof BaEditable> {
  const now = draftValues(draft);
  if (!now) return [];
  return (Object.keys(FIELD_LABELS) as Array<keyof BaEditable>).filter((k) => !sameJson(spec[k], now[k]));
}

/** Only the changed fields go to the server, so an untouched form accepts the proposal as it is. */
export function finalPatch(spec: BaEditable, draft: BaDraft): Partial<BaEditable> | undefined {
  const now = draftValues(draft);
  if (!now) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of changedSpecFields(spec, draft)) out[k] = now[k];
  return Object.keys(out).length ? (out as Partial<BaEditable>) : undefined;
}

/** Why a decision cannot be sent yet, in words, or null when it can. */
export function decisionBlocker(decision: BaDecision, draft: BaDraft, reason: string): string | null {
  if (decision !== "approve" && !reason.trim()) return "Write the reason first.";
  if (decision === "approve") {
    const now = draftValues(draft);
    if (!now) return "Each user story line needs three parts separated by |.";
    if (!now.summary) return "The summary cannot be empty.";
    if (!now.businessGoal) return "The business goal cannot be empty.";
    if (now.inScope.length === 0) return "List at least one item in scope.";
    if (now.acceptanceCriteria.length === 0) return "List at least one acceptance criterion.";
  }
  return null;
}

/** A link to the cited code at the commit the agent read, or null when the repository address is unknown. */
export function citationUrl(repos: BaDetail["repos"], area: BaArea): string | null {
  const repo = repos.find((r) => r.system === area.system);
  if (!repo?.repoUrl) return null;
  const path = area.path.split("/").map(encodeURIComponent).join("/");
  return `${repo.repoUrl.replace(/\/+$/, "")}/blob/${repo.sha}/${path}${area.line ? `#L${area.line}` : ""}`;
}

export const citationLabel = (area: BaArea): string => `${area.path}${area.line ? `:${area.line}` : ""}`;

export const CONFIDENCE_LABEL: Record<string, string> = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" };

const seenKey = (companyId: string) => `devflow.ba.seenAt:${companyId}`;
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

export const usd = (v: number | null): string => (v === null ? "-" : `${v.toFixed(2)} USD`);

export const FAILURE_LABELS: Record<string, string> = {
  "agent.ba_failed": "Run failed",
  "agent.ba_gave_up": "Gave up",
  "agent.ba_budget_paused": "Paused: daily spend cap",
};
