import type { HistoryItem, HistoryKind, RequestHistory } from "../api/devflowHistory";

// Words and small calculations for the request history page (openspec change add-request-history).

export const KIND_LABELS: Record<HistoryKind, string> = {
  submitted: "Submitted",
  stage: "Stage",
  decision: "Decision",
  field_change: "Changed",
  proposal: "Proposal",
  agent_run: "Agent run",
  agent_failed: "Agent problem",
  email: "Email",
};

/** Which kinds a person scans for first; the page lets the reader narrow the list to these. */
export const KEY_KINDS: readonly HistoryKind[] = ["decision", "field_change", "agent_failed"];

export function filterItems(items: readonly HistoryItem[], keyOnly: boolean): HistoryItem[] {
  return keyOnly ? items.filter((i) => KEY_KINDS.includes(i.kind)) : [...items];
}

/** "2d 3h", "45m", "30s": how long a stage held the request (still open when `leftAt` is null). */
export function stageDuration(enteredAt: string, leftAt: string | null, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((leftAt ? new Date(leftAt).getTime() : now) - new Date(enteredAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The pull requests an item links to, from its details (`pullRequest1`, `pullRequest1Url`...). */
export function itemLinks(item: HistoryItem): Array<{ label: string; url: string }> {
  const out: Array<{ label: string; url: string }> = [];
  for (let i = 1; i < 10; i++) {
    const label = item.details[`pullRequest${i}`];
    const url = item.details[`pullRequest${i}Url`];
    if (typeof label === "string" && typeof url === "string" && /^https:\/\/github\.com\//.test(url)) out.push({ label, url });
  }
  return out;
}

/** Total cost per agent role, for the summary line. */
export function costByRole(items: readonly HistoryItem[]): Array<{ role: string; usd: number }> {
  const by = new Map<string, number>();
  for (const i of items) {
    if (i.kind !== "agent_run") continue;
    const role = String(i.details.role ?? "agent");
    by.set(role, (by.get(role) ?? 0) + (typeof i.details.costUsd === "number" ? i.details.costUsd : 0));
  }
  return [...by.entries()].map(([role, usd]) => ({ role, usd: Math.round(usd * 10000) / 10000 })).sort((a, b) => b.usd - a.usd);
}

export const requestSummary = (h: RequestHistory): string =>
  [h.request.classification, h.request.priority, h.request.difficulty].filter(Boolean).join(" · ") || "not triaged yet";
