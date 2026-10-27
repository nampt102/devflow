import type { BoardCard, BoardColumn } from "../api/devflowBoard";

// Pure parts of the Requests board (openspec change add-request-board): filters, grouping by column, and the saved views kept
// in the browser (try/catch everywhere: storage can be blocked, and the page must work without it).

export type BoardLayout = "kanban" | "list";

export interface BoardFilter {
  text: string;
  priority: string;
  classification: string;
  system: string;
  requester: string;
  /** only what the viewer may decide at the stage the request waits in */
  mine: boolean;
}

export const EMPTY_FILTER: BoardFilter = { text: "", priority: "", classification: "", system: "", requester: "", mine: false };

export interface SavedView {
  name: string;
  layout: BoardLayout;
  filter: BoardFilter;
}

export function matches(card: BoardCard, f: BoardFilter): boolean {
  const text = f.text.trim().toLowerCase();
  if (text && !card.title.toLowerCase().includes(text) && !card.caseKey.toLowerCase().includes(text)) return false;
  if (f.priority && card.priority !== f.priority) return false;
  if (f.classification && card.classification !== f.classification) return false;
  if (f.system && !card.systems.includes(f.system)) return false;
  if (f.requester && card.requesterName !== f.requester) return false;
  if (f.mine && !(card.waitingFor === "person" && card.canDecide)) return false;
  return true;
}

export const filterCards = (cards: readonly BoardCard[], f: BoardFilter): BoardCard[] => cards.filter((c) => matches(c, f));

/** Cards per column, in the pipeline's column order; a card whose stage is unknown lands nowhere (never a crash). Oldest in the stage first. */
export function groupByColumn(columns: readonly BoardColumn[], cards: readonly BoardCard[]): Array<{ column: BoardColumn; cards: BoardCard[] }> {
  return columns.map((column) => ({
    column,
    cards: cards.filter((c) => c.stageKey === column.key).sort((a, b) => new Date(a.stageEnteredAt).getTime() - new Date(b.stageEnteredAt).getTime()),
  }));
}

/** The distinct values to offer in a filter, sorted. */
export function optionsOf(cards: readonly BoardCard[], pick: (c: BoardCard) => string | null | string[]): string[] {
  const set = new Set<string>();
  for (const c of cards) {
    const v = pick(c);
    for (const x of Array.isArray(v) ? v : [v]) if (x) set.add(x);
  }
  return [...set].sort();
}

export const activeFilterCount = (f: BoardFilter): number => [f.text.trim(), f.priority, f.classification, f.system, f.requester].filter(Boolean).length + (f.mine ? 1 : 0);

const storageKey = (companyId: string) => `devflow:requests:${companyId}:views`;

export function readViews(companyId: string): SavedView[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(companyId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v) => v && typeof v.name === "string" && (v.layout === "kanban" || v.layout === "list") && v.filter && typeof v.filter === "object")
      .map((v) => ({ name: v.name as string, layout: v.layout as BoardLayout, filter: { ...EMPTY_FILTER, ...v.filter } }));
  } catch {
    return [];
  }
}

function writeViews(companyId: string, views: SavedView[]): boolean {
  try {
    localStorage.setItem(storageKey(companyId), JSON.stringify(views));
    return true;
  } catch {
    return false;
  }
}

/** Save under a name (the same name replaces); returns the views now stored, or null when the name is empty or storage refused. */
export function saveView(companyId: string, view: SavedView): SavedView[] | null {
  const name = view.name.trim();
  if (!name) return null;
  const next = [...readViews(companyId).filter((v) => v.name !== name), { ...view, name }];
  return writeViews(companyId, next) ? next : null;
}

export function deleteView(companyId: string, name: string): SavedView[] {
  const next = readViews(companyId).filter((v) => v.name !== name);
  writeViews(companyId, next);
  return next;
}
