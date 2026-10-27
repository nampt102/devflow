import { describe, expect, it } from "vitest";
import type { HistoryItem } from "../api/devflowHistory";
import { costByRole, filterItems, itemLinks, stageDuration } from "./request-history";

const item = (kind: HistoryItem["kind"], details: HistoryItem["details"] = {}): HistoryItem => ({ at: "2026-10-20T00:00:00Z", kind, actor: null, summary: kind, details });

describe("request history helpers", () => {
  it("narrows to what a reader scans first: decisions, changes, problems", () => {
    const all = [item("stage"), item("decision"), item("email"), item("field_change"), item("agent_failed"), item("agent_run")];
    expect(filterItems(all, true).map((i) => i.kind)).toEqual(["decision", "field_change", "agent_failed"]);
    expect(filterItems(all, false)).toHaveLength(6);
  });

  it("words how long a stage held the request", () => {
    expect(stageDuration("2026-10-20T00:00:00Z", "2026-10-20T00:00:30Z")).toBe("30s");
    expect(stageDuration("2026-10-20T00:00:00Z", "2026-10-20T00:45:00Z")).toBe("45m");
    expect(stageDuration("2026-10-20T00:00:00Z", "2026-10-20T05:10:00Z")).toBe("5h 10m");
    expect(stageDuration("2026-10-20T00:00:00Z", "2026-10-22T03:00:00Z")).toBe("2d 3h");
    expect(stageDuration("2026-10-20T00:00:00Z", null, new Date("2026-10-20T00:02:00Z").getTime())).toBe("2m");
  });

  it("links only to GitHub pull requests", () => {
    const links = itemLinks(item("proposal", { pullRequest1: "reski #7", pullRequest1Url: "https://github.com/o/r/pull/7", pullRequest2: "x #1", pullRequest2Url: "javascript:alert(1)" }));
    expect(links).toEqual([{ label: "reski #7", url: "https://github.com/o/r/pull/7" }]);
  });

  it("adds up the agent cost by role, biggest first", () => {
    const runs = [item("agent_run", { role: "dev", costUsd: 0.3 }), item("agent_run", { role: "ba", costUsd: 0.05 }), item("agent_run", { role: "dev", costUsd: 0.06 }), item("email")];
    expect(costByRole(runs)).toEqual([{ role: "dev", usd: 0.36 }, { role: "ba", usd: 0.05 }]);
  });
});
