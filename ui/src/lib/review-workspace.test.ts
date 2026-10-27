import { describe, expect, it } from "vitest";
import { filterQueue, moveSelection, nextSelection, pickActive, reviewKeyAction, sortQueue, statusLine } from "./review-workspace";

const items = [
  { caseId: "a", caseKey: "REQ-1", createdAt: "2026-10-01T00:00:00Z" },
  { caseId: "b", caseKey: "REQ-2", createdAt: "2026-10-03T00:00:00Z" },
  { caseId: "c", caseKey: "REQ-3", createdAt: "2026-10-02T00:00:00Z" },
];

describe("what opens after a decision", () => {
  it("opens the item that followed, then the one before, then nothing", () => {
    expect(nextSelection(items, "a")).toBe("b");
    expect(nextSelection(items, "b")).toBe("c");
    expect(nextSelection(items, "c")).toBe("b");
    expect(nextSelection([items[0]!], "a")).toBeNull();
    expect(nextSelection(items, "gone")).toBe("a");
  });
});

describe("the item named in the URL", () => {
  it("opens it by key or id and falls back to the first", () => {
    expect(pickActive(items, "REQ-2")?.caseId).toBe("b");
    expect(pickActive(items, "c")?.caseId).toBe("c");
    expect(pickActive(items, "REQ-99")?.caseId).toBe("a");
    expect(pickActive(items, null)?.caseId).toBe("a");
    expect(pickActive([], "REQ-1")).toBeNull();
  });
});

describe("keys", () => {
  const press = (key: string, extra: Record<string, unknown> = {}) => reviewKeyAction({ key, target: { tagName: "BODY" }, ...extra });
  it("maps the review keys", () => {
    expect(press("j")).toEqual({ type: "move", delta: 1 });
    expect(press("k")).toEqual({ type: "move", delta: -1 });
    expect(press("a")).toEqual({ type: "decide", decision: "approve" });
    expect(press("r")).toEqual({ type: "decide", decision: "request_changes" });
    expect(press("x")).toEqual({ type: "decide", decision: "reject" });
    expect(press("?")).toEqual({ type: "help" });
    expect(press("z")).toBeNull();
  });
  it("does nothing while typing, with a modifier, or while a dialog is open", () => {
    expect(reviewKeyAction({ key: "a", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(reviewKeyAction({ key: "a", target: { tagName: "INPUT" } })).toBeNull();
    expect(reviewKeyAction({ key: "a", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(press("a", { ctrlKey: true })).toBeNull();
    expect(press("a", { metaKey: true })).toBeNull();
    expect(reviewKeyAction({ key: "x", target: { tagName: "BODY" } }, true)).toBeNull();
  });
});

describe("moving, sorting, filtering", () => {
  it("stays inside the list", () => {
    expect(moveSelection(items, "a", -1)).toBe("a");
    expect(moveSelection(items, "c", 1)).toBe("c");
    expect(moveSelection(items, "a", 1)).toBe("b");
    expect(moveSelection(items, null, 1)).toBe("b");
    expect(moveSelection([], "a", 1)).toBeNull();
  });
  it("sorts oldest or newest first without touching the input", () => {
    expect(sortQueue(items, "oldest").map((x) => x.caseKey)).toEqual(["REQ-1", "REQ-3", "REQ-2"]);
    expect(sortQueue(items, "newest").map((x) => x.caseKey)).toEqual(["REQ-2", "REQ-3", "REQ-1"]);
    expect(items.map((x) => x.caseKey)).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
  });
  it("keeps only what the viewer can decide when asked", () => {
    expect(filterQueue(items, true, (x) => x.caseKey !== "REQ-2").map((x) => x.caseKey)).toEqual(["REQ-1", "REQ-3"]);
    expect(filterQueue(items, false, () => false)).toHaveLength(3);
  });
});

describe("the one status line", () => {
  it("shows the heaviest signal, not a pile", () => {
    const warn = { tone: "warn" as const, icon: "rotate" as const, text: "Changes recommended" };
    const block = { tone: "block" as const, icon: "alert-triangle" as const, text: "1 test failed" };
    expect(statusLine([warn, null, block])).toBe(block);
    expect(statusLine([warn])).toBe(warn);
    expect(statusLine([]).text).toBe("Waiting for review");
  });
});
