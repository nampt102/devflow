import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard, BoardColumn } from "../api/devflowBoard";
import { EMPTY_FILTER, activeFilterCount, deleteView, filterCards, groupByColumn, optionsOf, readViews, saveView } from "./requests-board";

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
  it("narrows by text (title or key), priority, type, system and requester", () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, text: "kho" }).map((c) => c.caseKey)).toEqual(["REQ-2"]);
    expect(filterCards(cards, { ...EMPTY_FILTER, text: "req-3" }).map((c) => c.caseKey)).toEqual(["REQ-3"]);
    expect(filterCards(cards, { ...EMPTY_FILTER, priority: "low" }).map((c) => c.caseKey)).toEqual(["REQ-2"]);
    expect(filterCards(cards, { ...EMPTY_FILTER, classification: "bug" }).map((c) => c.caseKey)).toEqual(["REQ-3"]);
    expect(filterCards(cards, { ...EMPTY_FILTER, system: "erp" }).map((c) => c.caseKey)).toEqual(["REQ-2"]);
    expect(filterCards(cards, { ...EMPTY_FILTER, requester: "Bình" }).map((c) => c.caseKey)).toEqual(["REQ-3"]);
  });
  it("mine keeps only what a person waits on and the viewer may decide", () => {
    expect(filterCards(cards, { ...EMPTY_FILTER, mine: true }).map((c) => c.caseKey)).toEqual(["REQ-2"]);
  });
  it("counts the filters in use and lists the choices", () => {
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTER, text: "a", mine: true })).toBe(2);
    expect(optionsOf(cards, (c) => c.systems)).toEqual(["erp", "reski"]);
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
    expect(saveView("c1", { name: "Reski gấp", layout: "list", filter: { ...EMPTY_FILTER, priority: "high", system: "reski" } })).toHaveLength(1);
    saveView("c1", { name: "Reski gấp", layout: "kanban", filter: EMPTY_FILTER });
    saveView("c1", { name: "Của tôi", layout: "kanban", filter: { ...EMPTY_FILTER, mine: true } });
    expect(readViews("c1").map((v) => [v.name, v.layout])).toEqual([["Reski gấp", "kanban"], ["Của tôi", "kanban"]]);
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
