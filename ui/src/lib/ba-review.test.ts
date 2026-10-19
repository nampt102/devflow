import { describe, expect, it } from "vitest";
import type { BaEditable } from "../api/devflowBa";
import { changedSpecFields, citationLabel, citationUrl, decisionBlocker, draftFromSpec, draftValues, FAILURE_LABELS, finalPatch, parseStories, splitLines, storyToLine, usd } from "./ba-review";

const spec = (over: Partial<BaEditable> = {}): BaEditable => ({
  summary: "Cho phép người yêu cầu thấy người xử lý.",
  businessGoal: "Giảm email hỏi lại.",
  inScope: ["Hiển thị tên trên cổng"],
  outOfScope: ["Nhắn tin trực tiếp"],
  userStories: [{ asA: "người yêu cầu", iWant: "biết ai xử lý", soThat: "tôi biết hỏi ai" }],
  acceptanceCriteria: ["Trang chi tiết hiện tên", "Không hiện tên cho yêu cầu đã hủy"],
  dataChanges: [],
  risks: ["Lộ tên nhân viên"],
  openQuestions: ["Hiện ở mọi trạng thái?"],
  ...over,
});

describe("spec as text", () => {
  it("round-trips the spec through the editable text", () => {
    const s = spec();
    expect(draftValues(draftFromSpec(s))).toEqual(s);
    expect(draftFromSpec(s).userStories).toBe("người yêu cầu | biết ai xử lý | tôi biết hỏi ai");
    expect(changedSpecFields(s, draftFromSpec(s))).toEqual([]);
    expect(finalPatch(s, draftFromSpec(s))).toBeUndefined();
  });

  it("splits lists on lines, ignoring blank lines and spaces", () => {
    expect(splitLines(" a \r\n\n b\n  \nc ")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
  });

  it("parses user stories of exactly three parts, and refuses anything else", () => {
    expect(parseStories("a | b | c\nd|e|f")).toEqual([
      { asA: "a", iWant: "b", soThat: "c" },
      { asA: "d", iWant: "e", soThat: "f" },
    ]);
    expect(parseStories("")).toEqual([]);
    for (const bad of ["a | b", "a | b | c | d", "a | | c", "just text"]) expect(parseStories(bad), bad).toBeNull();
    expect(storyToLine({ asA: "x", iWant: "y", soThat: "z" })).toBe("x | y | z");
  });

  it("sends only what the reviewer changed", () => {
    const s = spec();
    const d = { ...draftFromSpec(s), acceptanceCriteria: "Trang chi tiết hiện tên\nTên hiện cả ở danh sách", risks: "" };
    expect(changedSpecFields(s, d).sort()).toEqual(["acceptanceCriteria", "risks"]);
    expect(finalPatch(s, d)).toEqual({ acceptanceCriteria: ["Trang chi tiết hiện tên", "Tên hiện cả ở danh sách"], risks: [] });
    // trailing spaces and blank lines are not a change
    expect(changedSpecFields(s, { ...draftFromSpec(s), summary: `${s.summary}  `, inScope: `${s.inScope[0]}\n\n` })).toEqual([]);
  });

  it("sends nothing while a story line is malformed", () => {
    const s = spec();
    expect(finalPatch(s, { ...draftFromSpec(s), userStories: "broken" })).toBeUndefined();
    expect(changedSpecFields(s, { ...draftFromSpec(s), userStories: "broken" })).toEqual([]);
  });
});

describe("decision blockers", () => {
  const d = draftFromSpec(spec());
  it("asks for a reason to reject or send back, not to approve", () => {
    expect(decisionBlocker("reject", d, " ")).toMatch(/reason/);
    expect(decisionBlocker("request_changes", d, "")).toMatch(/reason/);
    expect(decisionBlocker("request_changes", d, "thiếu")).toBeNull();
    expect(decisionBlocker("approve", d, "")).toBeNull();
  });

  it("does not let a broken spec be approved, but lets it be sent back", () => {
    expect(decisionBlocker("approve", { ...d, summary: " " }, "")).toMatch(/summary/);
    expect(decisionBlocker("approve", { ...d, businessGoal: "" }, "")).toMatch(/goal/);
    expect(decisionBlocker("approve", { ...d, inScope: "" }, "")).toMatch(/in scope/);
    expect(decisionBlocker("approve", { ...d, acceptanceCriteria: "" }, "")).toMatch(/acceptance/);
    expect(decisionBlocker("approve", { ...d, userStories: "x | y" }, "")).toMatch(/three parts/);
    expect(decisionBlocker("request_changes", { ...d, acceptanceCriteria: "" }, "làm lại")).toBeNull();
  });
});

describe("citations", () => {
  const repos = [
    { system: "portal", sha: "abc123", name: "Portal", repoUrl: "https://github.com/acme/portal" },
    { system: "erp", sha: "def456", name: "ERP", repoUrl: null },
  ];
  it("links to the cited line at the commit the agent read", () => {
    expect(citationUrl(repos, { system: "portal", path: "server/src/a b.ts", line: 17, why: "" })).toBe("https://github.com/acme/portal/blob/abc123/server/src/a%20b.ts#L17");
    expect(citationUrl(repos, { system: "portal", path: "README.md", line: null, why: "" })).toBe("https://github.com/acme/portal/blob/abc123/README.md");
  });
  it("gives no link when the repository is unknown", () => {
    expect(citationUrl(repos, { system: "erp", path: "x.ts", line: 1, why: "" })).toBeNull();
    expect(citationUrl(repos, { system: "other", path: "x.ts", line: 1, why: "" })).toBeNull();
  });
  it("labels a citation with path and line", () => {
    expect(citationLabel({ system: "portal", path: "a.ts", line: 3, why: "" })).toBe("a.ts:3");
    expect(citationLabel({ system: "portal", path: "a.ts", line: null, why: "" })).toBe("a.ts");
  });
});

describe("cost and failure labels", () => {
  it("shows money with two decimals and a dash when unknown", () => {
    expect(usd(1.5)).toBe("1.50 USD");
    expect(usd(0)).toBe("0.00 USD");
    expect(usd(0.123)).toBe("0.12 USD");
    expect(usd(null)).toBe("-");
  });
  it("names every problem the server records for the BA agent", () => {
    expect(Object.keys(FAILURE_LABELS).sort()).toEqual(["agent.ba_budget_paused", "agent.ba_failed", "agent.ba_gave_up"]);
  });
});
