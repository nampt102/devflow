import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard, BoardColumn } from "../api/devflowBoard";
import {
  DEFAULT_DISPLAY,
  EMPTY_FILTER,
  activeFilterCount,
  boardColumns,
  countBy,
  deleteView,
  filterCards,
  filterFromParams,
  filterToParams,
  groupByColumn,
  isCollapsed,
  normalizeDisplay,
  normalizeFilter,
  optionsOf,
  readDisplay,
  readViews,
  saveView,
  sortCards,
  toggleCollapsed,
  toggleValue,
  writeDisplay,
} from "./requests-board";

const card = (over: Partial<BoardCard>): BoardCard => ({
  caseId: over.caseKey ?? "x",
  caseKey: "REQ-1",
  title: "Công nợ",
  requesterName: "An",
  createdAt: "2026-10-01T00:00:00Z",
  stageKey: "triage",
  stageEnteredAt: "2026-10-02T00:00:00Z",
  classification: "feature",
  priority: "high",
  difficulty: "easy",
  systems: ["reski"],
  waitingFor: "agent",
  canDecide: false,
  reviewPage: null,
  lastFailure: null,
  terminal: null,
  ...over,
});
const columns: BoardColumn[] = [
  { key: "triage", name: "Triage", kind: "working" },
  { key: "ba_review", name: "BA review", kind: "review" },
];

describe("filters", () => {
  const cards = [
    card({ caseKey: "REQ-1", title: "Công nợ khách hàng" }),
    card({ caseKey: "REQ-2", title: "Báo cáo kho", priority: "low", systems: ["erp"], stageKey: "ba_review", waitingFor: "person", canDecide: true }),
    card({ caseKey: "REQ-3", title: "Xuất Excel", requesterName: "Bình", classification: "bug", stageKey: "ba_review", waitingFor: "person", canDecide: false }),
  ];
  const keys = (f: Partial<typeof EMPTY_FILTER>, now?: number) => filterCards(cards, { ...EMPTY_FILTER, ...f }, now).map((c) => c.caseKey);
  it("narrows by text (title or key), and by any of several values per field", () => {
    expect(keys({ text: "kho" })).toEqual(["REQ-2"]);
    expect(keys({ text: "req-3" })).toEqual(["REQ-3"]);
    expect(keys({ priority: ["low"] })).toEqual(["REQ-2"]);
    expect(keys({ priority: ["low", "high"] })).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
    expect(keys({ classification: ["bug"] })).toEqual(["REQ-3"]);
    expect(keys({ system: ["erp"] })).toEqual(["REQ-2"]);
    expect(keys({ requester: ["Bình"] })).toEqual(["REQ-3"]);
    expect(keys({ stage: ["triage"] })).toEqual(["REQ-1"]);
    expect(keys({ priority: ["high"], stage: ["ba_review"] })).toEqual(["REQ-3"]);
  });
  it("waiting: me is a person the viewer may decide for, person is any person, agent is the agent", () => {
    expect(keys({ waiting: ["me"] })).toEqual(["REQ-2"]);
    expect(keys({ waiting: ["person"] })).toEqual(["REQ-2", "REQ-3"]);
    expect(keys({ waiting: ["agent"] })).toEqual(["REQ-1"]);
  });
  it("age in stage, agent problems and closed requests", () => {
    const now = new Date("2026-10-06T00:00:00Z").getTime();
    const more = [...cards, card({ caseKey: "REQ-4", stageEnteredAt: "2026-10-05T12:00:00Z", lastFailure: { action: "agent.ba_failed", kind: "timeout", at: "2026-10-05T13:00:00Z" } }), card({ caseKey: "REQ-5", terminal: "done" })];
    const k = (f: Partial<typeof EMPTY_FILTER>) => filterCards(more, { ...EMPTY_FILTER, ...f }, now).map((c) => c.caseKey);
    expect(k({ age: "3" })).toEqual(["REQ-1", "REQ-2", "REQ-3", "REQ-5"]);
    expect(k({ age: "1" })).not.toContain("REQ-4");
    expect(k({ failing: true })).toEqual(["REQ-4"]);
    expect(k({ hideClosed: true })).not.toContain("REQ-5");
  });
  it("counts the filters in use, toggles values and lists the choices with counts", () => {
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTER, text: "a", waiting: ["me"], priority: ["high", "low"], failing: true })).toBe(4);
    const on = toggleValue(EMPTY_FILTER, "priority", "high");
    expect(on.priority).toEqual(["high"]);
    expect(toggleValue(on, "priority", "high").priority).toEqual([]);
    expect(optionsOf(cards, (c) => c.systems)).toEqual(["erp", "reski"]);
    expect(optionsOf([card({ priority: "low" }), card({ priority: "urgent" }), card({ priority: "medium" })], (c) => c.priority)).toEqual(["urgent", "medium", "low"]);
    expect(countBy(cards, (c) => c.stageKey)).toEqual(new Map([["triage", 1], ["ba_review", 2]]));
  });
  it("reads an older view: single values become lists and mine becomes waiting for me", () => {
    expect(normalizeFilter({ text: "x", priority: "high", system: "", mine: true, waiting: ["agent", "bogus"], age: "9" })).toEqual({
      ...EMPTY_FILTER,
      text: "x",
      priority: ["high"],
      waiting: ["agent", "me"],
    });
    expect(normalizeFilter(null)).toEqual(EMPTY_FILTER);
  });
  it("round-trips the filter and the layout through the URL", () => {
    const f = { ...EMPTY_FILTER, text: "kho", priority: ["high", "urgent"], classification: ["bug"], waiting: ["me" as const], age: "3" as const, failing: true, hideClosed: true };
    const p = filterToParams(f, "list");
    expect(p.getAll("priority")).toEqual(["high", "urgent"]);
    expect(p.get("type")).toBe("bug");
    expect(filterFromParams(p)).toEqual({ filter: f, layout: "list" });
    expect(filterFromParams(new URLSearchParams("age=bad&waiting=nobody"))).toEqual({ filter: EMPTY_FILTER, layout: "kanban" });
  });
});

describe("display", () => {
  const all: BoardColumn[] = [...columns, { key: "done", name: "Done", kind: "done" }, { key: "cancelled", name: "Cancelled", kind: "cancelled" }];
  it("sorts within a column by time in stage or by priority", () => {
    const list = [
      card({ caseKey: "L", priority: "low", stageEnteredAt: "2026-10-01T00:00:00Z" }),
      card({ caseKey: "U", priority: "urgent", stageEnteredAt: "2026-10-03T00:00:00Z" }),
      card({ caseKey: "N", priority: null, stageEnteredAt: "2026-10-02T00:00:00Z" }),
    ];
    expect(sortCards(list, "stage_oldest").map((c) => c.caseKey)).toEqual(["L", "N", "U"]);
    expect(sortCards(list, "stage_newest").map((c) => c.caseKey)).toEqual(["U", "N", "L"]);
    expect(sortCards(list, "priority").map((c) => c.caseKey)).toEqual(["U", "L", "N"]);
  });
  it("starts with Done and Cancelled collapsed, then remembers what the viewer chose", () => {
    expect(all.filter((c) => isCollapsed(DEFAULT_DISPLAY, c)).map((c) => c.key)).toEqual(["done", "cancelled"]);
    const opened = toggleCollapsed(DEFAULT_DISPLAY, all, "done");
    expect(opened.collapsed).toEqual(["cancelled"]);
    expect(toggleCollapsed(opened, all, "triage").collapsed).toEqual(["cancelled", "triage"]);
  });
  it("draws only the chosen stages, hides closed and empty columns when asked", () => {
    const list = [card({ caseKey: "T", stageKey: "triage" })];
    expect(boardColumns(all, list, EMPTY_FILTER, DEFAULT_DISPLAY).map((g) => g.column.key)).toEqual(["triage", "ba_review", "done", "cancelled"]);
    expect(boardColumns(all, list, { ...EMPTY_FILTER, stage: ["ba_review"] }, DEFAULT_DISPLAY).map((g) => g.column.key)).toEqual(["ba_review"]);
    expect(boardColumns(all, list, { ...EMPTY_FILTER, hideClosed: true }, DEFAULT_DISPLAY).map((g) => g.column.key)).toEqual(["triage", "ba_review"]);
    expect(boardColumns(all, list, EMPTY_FILTER, { ...DEFAULT_DISPLAY, showEmpty: false }).map((g) => g.column.key)).toEqual(["triage"]);
  });
  it("normalizes stored settings and survives blocked storage", () => {
    expect(normalizeDisplay({ props: ["age", "bogus"], sort: "x", showEmpty: false, collapsed: ["done"] })).toEqual({ props: ["age"], sort: "stage_oldest", showEmpty: false, collapsed: ["done"] });
    expect(normalizeDisplay(undefined)).toEqual(DEFAULT_DISPLAY);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readDisplay("c1")).toEqual(DEFAULT_DISPLAY);
    expect(() => writeDisplay("c1", DEFAULT_DISPLAY)).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("columns", () => {
  it("groups by the pipeline's columns, oldest in the stage first, and drops a card of an unknown stage", () => {
    const cards = [
      card({ caseKey: "B", stageKey: "ba_review", stageEnteredAt: "2026-10-05T00:00:00Z" }),
      card({ caseKey: "A", stageKey: "ba_review", stageEnteredAt: "2026-10-03T00:00:00Z" }),
      card({ caseKey: "T", stageKey: "triage" }),
      card({ caseKey: "Z", stageKey: "unknown" }),
    ];
    const g = groupByColumn(columns, cards);
    expect(g.map((x) => x.cards.map((c) => c.caseKey))).toEqual([["T"], ["A", "B"]]);
    expect(groupByColumn(columns, cards, "stage_newest")[1]!.cards.map((c) => c.caseKey)).toEqual(["B", "A"]);
  });
});

describe("saved views", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("saves, replaces by name, reads back and deletes", () => {
    expect(saveView("c1", { name: "Reski gấp", layout: "list", filter: { ...EMPTY_FILTER, priority: ["high"], system: ["reski"] } })).toHaveLength(1);
    saveView("c1", { name: "Reski gấp", layout: "kanban", filter: EMPTY_FILTER });
    saveView("c1", { name: "Của tôi", layout: "kanban", filter: { ...EMPTY_FILTER, waiting: ["me"] }, display: { ...DEFAULT_DISPLAY, sort: "priority" } });
    expect(readViews("c1").map((v) => [v.name, v.layout])).toEqual([["Reski gấp", "kanban"], ["Của tôi", "kanban"]]);
    expect(readViews("c1")[1]!.display?.sort).toBe("priority");
    // a view saved before multi-value filters still opens
    store.set("devflow:requests:c3:views", JSON.stringify([{ name: "cũ", layout: "list", filter: { priority: "high", mine: true } }]));
    expect(readViews("c3")[0]!.filter).toMatchObject({ priority: ["high"], waiting: ["me"] });
    expect(readViews("c2")).toEqual([]);
    expect(deleteView("c1", "Của tôi").map((v) => v.name)).toEqual(["Reski gấp"]);
  });
  it("refuses an empty name and survives broken or blocked storage", () => {
    expect(saveView("c1", { name: "  ", layout: "list", filter: EMPTY_FILTER })).toBeNull();
    store.set("devflow:requests:c1:views", "not json");
    expect(readViews("c1")).toEqual([]);
    store.set("devflow:requests:c1:views", JSON.stringify([{ name: 1 }, { name: "ok", layout: "list", filter: {} }]));
    expect(readViews("c1").map((v) => v.name)).toEqual(["ok"]);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readViews("c1")).toEqual([]);
    expect(saveView("c1", { name: "x", layout: "list", filter: EMPTY_FILTER })).toBeNull();
  });
});
