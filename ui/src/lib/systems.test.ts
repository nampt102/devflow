import { describe, expect, it } from "vitest";
import { suggestKey, systemsErrorMessage, validateSystemForm, type SystemForm } from "./systems";

const ok: SystemForm = { name: "HR Portal", key: "hr-portal", repoUrl: "https://github.com/acme/hr-portal", defaultBranch: "main", docsPath: "docs", description: "" };

describe("systems helpers", () => {
  it("suggests a key from a Vietnamese name", () => {
    expect(suggestKey("Cổng HR Portal")).toBe("cong-hr-portal");
    expect(suggestKey("  Đăng ký — Kế toán!! ")).toBe("dang-ky-ke-toan");
    expect(suggestKey("---")).toBe("");
    expect(suggestKey("x".repeat(100))).toHaveLength(63);
    expect(suggestKey("ERP 2.0")).toBe("erp-2-0");
  });

  it("accepts a good form", () => {
    expect(validateSystemForm(ok)).toEqual({});
    expect(validateSystemForm({ ...ok, repoUrl: "https://github.com/acme/hr-portal.git" })).toEqual({});
  });

  it("explains each field that is wrong", () => {
    const bad = validateSystemForm({ name: " ", key: "Bad Key", repoUrl: "http://github.com/a/b", defaultBranch: "--x", docsPath: "../x", description: "x".repeat(2001) });
    expect(Object.keys(bad).sort()).toEqual(["defaultBranch", "description", "docsPath", "key", "name", "repoUrl"]);
    for (const repoUrl of ["https://gitlab.com/a/b", "https://github.com/a", "https://user:pw@github.com/a/b", "https://github.com/a/b/tree/x"]) {
      expect(validateSystemForm({ ...ok, repoUrl }).repoUrl, repoUrl).toBeTruthy();
    }
    for (const defaultBranch of ["a..b", "main;x", "x/", "x.lock", ""]) expect(validateSystemForm({ ...ok, defaultBranch }).defaultBranch, defaultBranch).toBeTruthy();
    for (const docsPath of ["/etc", "docs/../..", ".."]) expect(validateSystemForm({ ...ok, docsPath }).docsPath, docsPath).toBeTruthy();
  });

  it("does not re-check the key and repository when editing (they cannot change)", () => {
    expect(validateSystemForm({ ...ok, key: "", repoUrl: "" }, { editing: true })).toEqual({});
  });

  it("turns the server's errors into something to act on", () => {
    expect(systemsErrorMessage({ status: 409, body: {} })).toMatch(/already exists/);
    expect(systemsErrorMessage({ status: 403, body: {} })).toMatch(/permission/);
    expect(systemsErrorMessage({ status: 404, body: {} })).toMatch(/Not found/);
    expect(systemsErrorMessage({ status: 400, body: { error: "Invalid branch" } })).toBe("Invalid branch");
    expect(systemsErrorMessage(null)).toMatch(/Something went wrong/);
  });
});
