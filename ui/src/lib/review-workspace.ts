// Pure parts of the shared review workspace (openspec change redesign-review-queues): which item to open next, what a key
// press means, and how the queue is filtered and sorted. The component only wires these to the screen.

export type ReviewDecision = "approve" | "request_changes" | "reject";

/** The item to open after `decidedId` left the list: the one that followed it, else the one before, else none. */
export function nextSelection<T extends { caseId: string }>(items: readonly T[], decidedId: string): string | null {
  const i = items.findIndex((x) => x.caseId === decidedId);
  if (i === -1) return items[0]?.caseId ?? null;
  return items[i + 1]?.caseId ?? items[i - 1]?.caseId ?? null;
}

/** The item to select: the one in the URL when it is in the list, else the first. */
export function pickActive<T extends { caseId: string; caseKey: string }>(items: readonly T[], wanted: string | null): T | null {
  if (!items.length) return null;
  if (wanted) {
    const hit = items.find((x) => x.caseKey === wanted || x.caseId === wanted);
    if (hit) return hit;
  }
  return items[0] ?? null;
}

export type ReviewKeyAction = { type: "move"; delta: 1 | -1 } | { type: "decide"; decision: ReviewDecision } | { type: "help" } | null;

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * What a key press means. Nothing while the person types in a field, while a modifier is held, or while a dialog is open
 * (`blocked`): a letter typed in the reason box must never decide a request.
 */
export function reviewKeyAction(
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: unknown },
  blocked = false,
): ReviewKeyAction {
  if (blocked || e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (t && (TYPING.has(t.tagName ?? "") || t.isContentEditable)) return null;
  switch (e.key) {
    case "j":
      return { type: "move", delta: 1 };
    case "k":
      return { type: "move", delta: -1 };
    case "a":
      return { type: "decide", decision: "approve" };
    case "r":
      return { type: "decide", decision: "request_changes" };
    case "x":
      return { type: "decide", decision: "reject" };
    case "?":
      return { type: "help" };
    default:
      return null;
  }
}

/** Move the selection by `delta`, staying inside the list. */
export function moveSelection<T extends { caseId: string }>(items: readonly T[], currentId: string | null, delta: 1 | -1): string | null {
  if (!items.length) return null;
  const i = items.findIndex((x) => x.caseId === currentId);
  const next = Math.min(Math.max((i === -1 ? 0 : i) + delta, 0), items.length - 1);
  return items[next]!.caseId;
}

export type QueueSort = "oldest" | "newest";

/** Oldest first (what has waited longest) or newest first. Ties keep their order. */
export function sortQueue<T extends { createdAt: string }>(items: readonly T[], sort: QueueSort): T[] {
  const dir = sort === "oldest" ? 1 : -1;
  return [...items].sort((a, b) => dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
}

/** The queue narrowed to what the viewer can decide, when asked. */
export function filterQueue<T>(items: readonly T[], mineOnly: boolean, canDecide: (item: T) => boolean): T[] {
  return mineOnly ? items.filter(canDecide) : [...items];
}

/** The decision button's one-line meaning, shown in the confirm box before something that cannot be undone. */
export const REJECT_CONFIRM_TEXT: Record<string, string> = {
  triage: "This closes the request. The requester is told it was not accepted.",
  ba: "This cancels the request.",
  plan: "This cancels the request.",
  code: "This closes the draft pull request (the branch stays) and cancels the request.",
  qa: "This closes the pull request (the branch stays) and cancels the request.",
};

/** The heaviest of the item's signals, as one line with an icon name, so the queue card never shows a pile of badges. */
export type StatusLine = { tone: "block" | "warn" | "ok" | "info"; icon: "alert-triangle" | "rotate" | "check" | "clock"; text: string };

export function statusLine(signals: Array<StatusLine | null | undefined>): StatusLine {
  const order = { block: 3, warn: 2, info: 1, ok: 0 } as const;
  const present = signals.filter((s): s is StatusLine => !!s);
  if (!present.length) return { tone: "info", icon: "clock", text: "Waiting for review" };
  return present.reduce((a, b) => (order[b.tone] > order[a.tone] ? b : a));
}
