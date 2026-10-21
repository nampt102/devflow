import { describe, expect, it } from "vitest";
import { parseForbiddenPaths, suggestKey, systemsErrorMessage, validateDevSettings, validateSystemForm, type DevForm, type SystemForm } from "./systems";

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

describe("agent Dev settings", () => {
  const dev: DevForm = { devEnabled: false, testCommand: "", forbiddenPaths: "", hasWriteToken: false, newWriteToken: "", removeWriteToken: false };

  it("splits forbidden paths by line or comma and drops blanks and repeats", () => {
    expect(parseForbiddenPaths("deploy/**\n\n *.pem ,deploy/**")).toEqual(["deploy/**", "*.pem"]);
  });

  it("needs a write token to turn Dev on, counting a stored or newly typed one", () => {
    expect(validateDevSettings({ ...dev, devEnabled: true }).writeToken).toBeTruthy();
    expect(validateDevSettings({ ...dev, devEnabled: true, newWriteToken: "ghp_x" }).writeToken).toBeUndefined();
    expect(validateDevSettings({ ...dev, devEnabled: true, hasWriteToken: true }).writeToken).toBeUndefined();
    expect(validateDevSettings({ ...dev, devEnabled: true, hasWriteToken: true, removeWriteToken: true }).writeToken).toBeTruthy();
    expect(validateDevSettings({ ...dev, hasWriteToken: true, removeWriteToken: true })).toEqual({});
  });

  it("refuses paths outside the repository, odd characters, too long a command and too many paths", () => {
    for (const bad of ["../x", "/etc", "a/../b", "a b", "x;y"]) expect(validateDevSettings({ ...dev, forbiddenPaths: bad }).forbiddenPaths, bad).toBeTruthy();
    expect(validateDevSettings({ ...dev, forbiddenPaths: Array.from({ length: 51 }, (_, i) => `p${i}`).join("\n") }).forbiddenPaths).toBeTruthy();
    expect(validateDevSettings({ ...dev, testCommand: "x".repeat(501) }).testCommand).toBeTruthy();
    expect(validateDevSettings({ ...dev, testCommand: "npm test", forbiddenPaths: "deploy/**\n*.pem" })).toEqual({});
  });
});
