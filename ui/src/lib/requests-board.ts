import type { BoardCard, BoardColumn } from "../api/devflowBoard";

// Pure parts of the Requests board (openspec change add-request-board): filters, grouping by column, and the saved views kept
// in the browser (try/catch everywhere: storage can be blocked, and the page must work without it).

export type BoardLayout = "kanban" | "list";
export type WaitingKey = "me" | "person" | "agent";
export type AgeKey = "" | "1" | "3" | "7";

/** Every list is "any of"; an empty list does not narrow. */
export interface BoardFilter {
  text: string;
  waiting: WaitingKey[];
  priority: string[];
  classification: string[];
  system: string[];
  requester: string[];
  stage: string[];
  /** at least this many days in the current stage */
  age: AgeKey;
  failing: boolean;
  hideClosed: boolean;
}

export const EMPTY_FILTER: BoardFilter = { text: "", waiting: [], priority: [], classification: [], system: [], requester: [], stage: [], age: "", failing: false, hideClosed: false };

export const LIST_FILTERS = ["waiting", "priority", "classification", "system", "requester", "stage"] as const;
export type ListFilterKey = (typeof LIST_FILTERS)[number];

export const WAITING_KEYS: readonly WaitingKey[] = ["me", "person", "agent"];
export const AGE_KEYS: readonly Exclude<AgeKey, "">[] = ["1", "3", "7"];
export const PRIORITY_ORDER: readonly string[] = ["urgent", "high", "medium", "low"];

export type CardProp = "priority" | "classification" | "systems" | "age" | "requester";
export const CARD_PROPS: readonly CardProp[] = ["priority", "classification", "systems", "age", "requester"];
export type CardSort = "stage_oldest" | "stage_newest" | "priority";
const CARD_SORTS: readonly CardSort[] = ["stage_oldest", "stage_newest", "priority"];

/** How the board looks, kept per company in this browser. */
export interface BoardDisplay {
  props: CardProp[];
  sort: CardSort;
  showEmpty: boolean;
  /** column keys shown as a narrow strip; null until changed, when Done and Cancelled start collapsed */
  collapsed: string[] | null;
}

export const DEFAULT_DISPLAY: BoardDisplay = { props: [...CARD_PROPS], sort: "stage_oldest", showEmpty: true, collapsed: null };

export interface SavedView {
  name: string;
  layout: BoardLayout;
  filter: BoardFilter;
  display?: BoardDisplay;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter((x): x is string => typeof x === "string" && x.length > 0);
const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];
const record = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});

/** A filter from the URL, storage or an older view: single values become lists, `mine` becomes "waiting for me", junk is dropped. */
export function normalizeFilter(raw: unknown): BoardFilter {
  const r = record(raw);
  const waiting = strings(r.waiting).filter((w): w is WaitingKey => (WAITING_KEYS as readonly string[]).includes(w));
  if (r.mine === true) waiting.push("me");
  return {
    text: typeof r.text === "string" ? r.text : "",
    waiting: unique(waiting),
    priority: unique(strings(r.priority)),
    classification: unique(strings(r.classification)),
    system: unique(strings(r.system)),
    requester: unique(strings(r.requester)),
    stage: unique(strings(r.stage)),
    age: (AGE_KEYS as readonly string[]).includes(r.age as string) ? (r.age as AgeKey) : "",
    failing: r.failing === true,
    hideClosed: r.hideClosed === true,
  };
}

const DAY = 86_400_000;

/** Which "waiting for" choices a card answers to: a person the viewer may stand in for is also "me". */
export const waitingOf = (c: BoardCard): WaitingKey[] => (c.waitingFor === "person" ? (c.canDecide ? ["person", "me"] : ["person"]) : c.waitingFor === "agent" ? ["agent"] : []);
const anyOf = (picked: readonly string[], values: ReadonlyArray<string | null>) => picked.length === 0 || values.some((v) => v !== null && picked.includes(v));
export const daysInStage = (c: BoardCard, now: number = Date.now()) => (now - new Date(c.stageEnteredAt).getTime()) / DAY;

export function matches(card: BoardCard, f: BoardFilter, now: number = Date.now()): boolean {
  const text = f.text.trim().toLowerCase();
  if (text && !card.title.toLowerCase().includes(text) && !card.caseKey.toLowerCase().includes(text)) return false;
  if (!anyOf(f.waiting, waitingOf(card))) return false;
  if (!anyOf(f.priority, [card.priority])) return false;
  if (!anyOf(f.classification, [card.classification])) return false;
  if (!anyOf(f.system, card.systems)) return false;
  if (!anyOf(f.requester, [card.requesterName])) return false;
  if (!anyOf(f.stage, [card.stageKey])) return false;
  if (f.age && daysInStage(card, now) < Number(f.age)) return false;
  if (f.failing && !card.lastFailure) return false;
  if (f.hideClosed && card.terminal) return false;
  return true;
}

export const filterCards = (cards: readonly BoardCard[], f: BoardFilter, now: number = Date.now()): BoardCard[] => cards.filter((c) => matches(c, f, now));

export const activeFilterCount = (f: BoardFilter): number =>
  (f.text.trim() ? 1 : 0) + LIST_FILTERS.filter((k) => f[k].length > 0).length + (f.age ? 1 : 0) + (f.failing ? 1 : 0) + (f.hideClosed ? 1 : 0);

/** Add the value to a list filter, or take it out when it is there. */
export function toggleValue(f: BoardFilter, key: ListFilterKey, value: string): BoardFilter {
  const list = f[key] as string[];
  return { ...f, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
}

const priorityRank = (p: string | null) => {
  const i = p ? PRIORITY_ORDER.indexOf(p) : -1;
  return i === -1 ? PRIORITY_ORDER.length : i;
};
const enteredAt = (c: BoardCard) => new Date(c.stageEnteredAt).getTime();

export function sortCards(cards: readonly BoardCard[], sort: CardSort): BoardCard[] {
  return [...cards].sort((a, b) => {
    if (sort === "stage_newest") return enteredAt(b) - enteredAt(a);
    if (sort === "priority") return priorityRank(a.priority) - priorityRank(b.priority) || enteredAt(a) - enteredAt(b);
    return enteredAt(a) - enteredAt(b);
  });
}

/** Cards per column, in the pipeline's column order; a card whose stage is unknown lands nowhere (never a crash). */
export function groupByColumn(columns: readonly BoardColumn[], cards: readonly BoardCard[], sort: CardSort = "stage_oldest"): Array<{ column: BoardColumn; cards: BoardCard[] }> {
  return columns.map((column) => ({ column, cards: sortCards(cards.filter((c) => c.stageKey === column.key), sort) }));
}

const isClosedColumn = (c: BoardColumn) => c.kind === "done" || c.kind === "cancelled";

export function isCollapsed(display: BoardDisplay, column: BoardColumn): boolean {
  return display.collapsed ? display.collapsed.includes(column.key) : isClosedColumn(column);
}

export function toggleCollapsed(display: BoardDisplay, columns: readonly BoardColumn[], key: string): BoardDisplay {
  const now = columns.filter((c) => isCollapsed(display, c)).map((c) => c.key);
  return { ...display, collapsed: now.includes(key) ? now.filter((k) => k !== key) : [...now, key] };
}

/** The columns to draw: narrowed by the stage filter and "hide closed", without empty ones when asked, each with its collapsed state. */
export function boardColumns(columns: readonly BoardColumn[], cards: readonly BoardCard[], f: BoardFilter, d: BoardDisplay) {
  return groupByColumn(columns, cards, d.sort)
    .filter(({ column }) => f.stage.length === 0 || f.stage.includes(column.key))
    .filter(({ column }) => !(f.hideClosed && isClosedColumn(column)))
    .filter(({ cards: list }) => d.showEmpty || list.length > 0)
    .map((g) => ({ ...g, collapsed: isCollapsed(d, g.column) }));
}

/** How many cards carry each value, for the counts beside the filter choices. */
export function countBy(cards: readonly BoardCard[], pick: (c: BoardCard) => string | null | readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cards) {
    const v = pick(c);
    for (const x of unique(Array.isArray(v) ? [...v] : [v as string | null])) if (x) out.set(x, (out.get(x) ?? 0) + 1);
  }
  return out;
}

/** The distinct values to offer in a filter, sorted (priorities from most to least urgent). */
export function optionsOf(cards: readonly BoardCard[], pick: (c: BoardCard) => string | null | readonly string[]): string[] {
  return [...countBy(cards, pick).keys()].sort((a, b) => priorityRank(a) - priorityRank(b) || a.localeCompare(b));
}

// ---- URL: a filtered board can be shared as a link ----------------------------------------------------------------------
const PARAM: Record<ListFilterKey, string> = { waiting: "waiting", priority: "priority", classification: "type", system: "system", requester: "requester", stage: "stage" };

export function filterToParams(f: BoardFilter, layout: BoardLayout): URLSearchParams {
  const p = new URLSearchParams();
  if (f.text) p.set("q", f.text);
  for (const k of LIST_FILTERS) for (const v of f[k]) p.append(PARAM[k], v);
  if (f.age) p.set("age", f.age);
  if (f.failing) p.set("failing", "1");
  if (f.hideClosed) p.set("closed", "hide");
  if (layout === "list") p.set("layout", "list");
  return p;
}

export function filterFromParams(p: URLSearchParams): { filter: BoardFilter; layout: BoardLayout } {
  const raw: Record<string, unknown> = { text: p.get("q") ?? "", age: p.get("age") ?? "", failing: p.get("failing") === "1", hideClosed: p.get("closed") === "hide" };
  for (const k of LIST_FILTERS) raw[k] = p.getAll(PARAM[k]);
  return { filter: normalizeFilter(raw), layout: p.get("layout") === "list" ? "list" : "kanban" };
}

// ---- display settings in this browser ----------------------------------------------------------------------------------
export function normalizeDisplay(raw: unknown): BoardDisplay {
  const r = record(raw);
  return {
    props: Array.isArray(r.props) ? unique(strings(r.props).filter((p): p is CardProp => (CARD_PROPS as readonly string[]).includes(p))) : [...DEFAULT_DISPLAY.props],
    sort: (CARD_SORTS as readonly string[]).includes(r.sort as string) ? (r.sort as CardSort) : DEFAULT_DISPLAY.sort,
    showEmpty: typeof r.showEmpty === "boolean" ? r.showEmpty : DEFAULT_DISPLAY.showEmpty,
    collapsed: Array.isArray(r.collapsed) ? unique(strings(r.collapsed)) : null,
  };
}

const displayKey = (companyId: string) => `devflow:requests:${companyId}:display`;

export function readDisplay(companyId: string): BoardDisplay {
  try {
    const raw = localStorage.getItem(displayKey(companyId));
    return raw ? normalizeDisplay(JSON.parse(raw)) : { ...DEFAULT_DISPLAY, props: [...DEFAULT_DISPLAY.props] };
  } catch {
    return { ...DEFAULT_DISPLAY, props: [...DEFAULT_DISPLAY.props] };
  }
}

export function writeDisplay(companyId: string, display: BoardDisplay): void {
  try {
    localStorage.setItem(displayKey(companyId), JSON.stringify(display));
  } catch {
    // storage blocked: the setting lasts until the page is left
  }
}

const storageKey = (companyId: string) => `devflow:requests:${companyId}:views`;

export function readViews(companyId: string): SavedView[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(companyId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v) => v && typeof v.name === "string" && (v.layout === "kanban" || v.layout === "list") && v.filter && typeof v.filter === "object")
      .map((v) => ({ name: v.name as string, layout: v.layout as BoardLayout, filter: normalizeFilter(v.filter), ...(v.display ? { display: normalizeDisplay(v.display) } : {}) }));
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
