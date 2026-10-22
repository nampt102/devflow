import { describe, expect, it } from "vitest";
import type { CodeDecisionResult, CodeRepo } from "../api/devflowCode";
import { BLOCKED_LABELS, codeDecisionBlocker, compareTasks, decisionSummary, repoOutcome, safeGithubUrl } from "./code-review";

const repo = (over: Partial<CodeRepo> = {}): CodeRepo => ({ system: "portal", name: "Portal", repoUrl: "https://github.com/acme/portal", branch: "devflow/REQ-1", baseBranch: "main", baseSha: "a".repeat(40), ...over });

describe("decision blockers", () => {
  it("needs a reason to reject or send back, and refuses approval when the server would", () => {
    expect(codeDecisionBlocker("reject", "  ", null)).toBeTruthy();
    expect(codeDecisionBlocker("request_changes", "", null)).toBeTruthy();
    expect(codeDecisionBlocker("reject", "Hướng sai", null)).toBeNull();
    expect(codeDecisionBlocker("approve", "", null)).toBeNull();
    expect(codeDecisionBlocker("approve", "", "no_pull_request")).toMatch(/no pull request/i);
    expect(codeDecisionBlocker("approve", "", "blocked_diff")).toMatch(/check refused/i);
    // sending back or rejecting is always possible for work that cannot be approved
    expect(codeDecisionBlocker("request_changes", "Chia nhỏ", "blocked_diff")).toBeNull();
  });
});

describe("links", () => {
  it("opens only GitHub pull request links", () => {
    expect(safeGithubUrl("https://github.com/acme/portal/pull/41")).toBe("https://github.com/acme/portal/pull/41");
    for (const bad of ["javascript:alert(1)", "http://github.com/a/b/pull/1", "https://evil.test/a/b", "https://github.com.evil.test/a/b", "https://github.com/a", "", null, undefined]) {
      expect(safeGithubUrl(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("what happened to each repository", () => {
  it("tells a pull request from a refused diff and from no change at all", () => {
    expect(repoOutcome(repo({ prNumber: 41, prUrl: "https://github.com/acme/portal/pull/41", filesChanged: 1, additions: 3, deletions: 0, commits: 2 }))).toEqual({
      kind: "pull_request",
      url: "https://github.com/acme/portal/pull/41",
      number: 41,
      stats: "1 file, +3 -0, 2 commits",
      warning: false,
    });
    expect(repoOutcome(repo({ prNumber: 2, prUrl: "javascript:x", filesChanged: 2, unprotectedWarning: true }))).toMatchObject({ kind: "pull_request", url: null, warning: true });
    expect(repoOutcome(repo({ blocked: { kind: "forbidden_paths", paths: [".github/workflows/x.yml"] } }))).toEqual({ kind: "blocked", label: BLOCKED_LABELS.forbidden_paths, paths: [".github/workflows/x.yml"] });
    expect(repoOutcome(repo({ blocked: { kind: "something_new", paths: [] } }))).toMatchObject({ kind: "blocked", label: "something_new" });
    expect(repoOutcome(repo({ noChanges: true }))).toEqual({ kind: "no_changes" });
  });
});

describe("plan against report", () => {
  const plan = [
    { id: "T1", title: "Thêm trường", system: "portal", size: "S" },
    { id: "T2", title: "Hiện trên trang", system: "portal", size: "M" },
  ];
  it("lines up each planned task with what the agent said and flags one it did not report", () => {
    const rows = compareTasks(plan, [{ id: "T1", status: "done", notes: "Xong" }]);
    expect(rows).toEqual([
      { id: "T1", title: "Thêm trường", size: "S", system: "portal", status: "done", notes: "Xong" },
      { id: "T2", title: "Hiện trên trang", size: "M", system: "portal", status: "not_reported", notes: null },
    ]);
  });
  it("keeps a reported task the plan does not know instead of dropping it", () => {
    expect(compareTasks(plan, [{ id: "T9", status: "partial", notes: "?" }]).map((r) => r.id)).toEqual(["T1", "T2", "T9"]);
  });
});

describe("decision summary", () => {
  const result = (decision: CodeDecisionResult["decision"], closed: CodeDecisionResult["closedPullRequests"] = []): CodeDecisionResult => ({ ok: true, decision, closedPullRequests: closed });
  it("names a pull request that must be closed by hand", () => {
    expect(decisionSummary("REQ-1", result("reject", [{ system: "portal", prNumber: 41, closed: false }]))).toMatchObject({ tone: "warn", body: expect.stringContaining("#41 (portal)") });
  });
  it("reports closed pull requests and plain approvals", () => {
    expect(decisionSummary("REQ-1", result("reject", [{ system: "portal", prNumber: 41, closed: true }]))).toEqual({ title: "REQ-1 rejected", body: "1 pull request closed.", tone: "success" });
    expect(decisionSummary("REQ-2", result("approve"))).toEqual({ title: "REQ-2 approved", body: undefined, tone: "success" });
    expect(decisionSummary("REQ-3", result("request_changes")).title).toBe("REQ-3 sent back");
  });
});
