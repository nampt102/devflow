import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StageFailure } from "../devflow/agent-stage/failure.js";
import { devBranchName, devWorkspace, prepareDevRepo, REPOS_DIR } from "../devflow/dev/workspace.js";

// The Dev agent's workspace (openspec/changes/add-dev-stage, task 3.4), against a local repository standing in for GitHub.
const REPO = "https://github.com/acme/hr-portal";
const TOKEN = "ghp_TESTTOKEN_abc123";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

describe("Dev workspace", () => {
  let tmp: string;
  let origin: string;
  let mainSha: string;
  let resumedSha: string;
  const via = () => ({
    GIT_ALLOW_PROTOCOL: "file:https",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: REPO,
  });
  const input = (name: string, over: Record<string, unknown> = {}) => ({
    repoUrl: REPO,
    defaultBranch: "main",
    devBranch: "devflow/REQ-5",
    dest: path.join(tmp, name),
    token: TOKEN,
    env: via(),
    ...over,
  });

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-devws-"));
    origin = path.join(tmp, "origin");
    fs.mkdirSync(path.join(origin, "src"), { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(origin, "src", `f${n}.txt`), `${n}\n`);
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", `c${n}`);
    }
    fs.symlinkSync("src/f1.txt", path.join(origin, "link-in-repo"));
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "link");
    mainSha = git(origin, "rev-parse", "HEAD");
    // an earlier run already pushed this request's branch
    git(origin, "checkout", "-q", "-b", "devflow/REQ-7");
    fs.writeFileSync(path.join(origin, "src", "earlier.txt"), "earlier run\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "earlier run");
    resumedSha = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "main");
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("starts a new branch from the base branch, with full history, no remote and no hooks", async () => {
    const dest = path.join(tmp, "new");
    const result = await prepareDevRepo(input("new"));
    expect(result).toEqual({ sha: mainSha, resumed: false });
    expect(git(dest, "branch", "--show-current")).toBe("devflow/REQ-5");
    // a shallow clone cannot be shipped to the runner (git bundle), so the clone must be complete
    expect(git(dest, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("4");
    expect(() => git(dest, "bundle", "create", path.join(tmp, "new.bundle"), "HEAD")).not.toThrow();
    expect(git(dest, "remote")).toBe("");
    expect(git(dest, "config", "core.hooksPath")).toBe("/dev/null");
    expect(fs.readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(TOKEN);
    // the repository's own symlinks are content, not something to strip (the diff would show them deleted)
    expect(fs.lstatSync(path.join(dest, "link-in-repo")).isSymbolicLink()).toBe(true);
    expect(git(dest, "status", "--porcelain")).toBe("");
  });

  it("continues the branch an earlier run pushed", async () => {
    const dest = path.join(tmp, "resumed");
    const result = await prepareDevRepo(input("resumed", { devBranch: "devflow/REQ-7" }));
    expect(result).toEqual({ sha: resumedSha, resumed: true });
    expect(git(dest, "branch", "--show-current")).toBe("devflow/REQ-7");
    expect(fs.readFileSync(path.join(dest, "src", "earlier.txt"), "utf8")).toBe("earlier run\n");
  });

  it("for QA, checks the pull request's branch as GitHub has it and refuses to make one", async () => {
    const dest = path.join(tmp, "qa-existing");
    const result = await prepareDevRepo(input("qa-existing", { devBranch: "devflow/REQ-7", existingOnly: true }));
    expect(result).toEqual({ sha: resumedSha, resumed: true });
    expect(git(dest, "branch", "--show-current")).toBe("devflow/REQ-7");
    expect(git(dest, "remote")).toBe("");
    // no such branch on GitHub (deleted, or never pushed): no new branch from the base branch, and nothing left on disk
    const gone = path.join(tmp, "qa-missing");
    const err = await prepareDevRepo(input("qa-missing", { devBranch: "devflow/REQ-99", existingOnly: true })).catch((e) => e as Error);
    expect(err.message).toBe("branch_missing");
    expect(fs.existsSync(gone)).toBe(false);
  });

  it("works for a public repository without a token", async () => {
    expect((await prepareDevRepo(input("public", { token: null }))).resumed).toBe(false);
  });

  it("refuses a URL or branch that is not what the catalog allows, before touching git", async () => {
    for (const over of [
      { repoUrl: "http://github.com/a/b" },
      { repoUrl: "https://evil.test/a/b" },
      { repoUrl: "https://github.com/a/b --upload-pack=x" },
      { defaultBranch: "--upload-pack=x" },
      { defaultBranch: "a..b" },
      { devBranch: "main" },
      { devBranch: "devflow/../x" },
      { devBranch: "devflow/a b" },
    ]) {
      await expect(prepareDevRepo(input("bad", over)), JSON.stringify(over)).rejects.toThrow();
    }
    expect(fs.existsSync(path.join(tmp, "bad"))).toBe(false);
  });

  it("reports only that the clone failed, and leaves nothing behind", async () => {
    const dest = path.join(tmp, "missing");
    const err = await prepareDevRepo(input("missing", { defaultBranch: "no-such-branch" })).catch((e) => e as Error);
    expect(err.message).toBe("clone_failed");
    expect(String(err.stack)).not.toContain(TOKEN);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("names the branch after the request and refuses keys that are not safe in a branch name", () => {
    expect(devBranchName("REQ-5")).toBe("devflow/REQ-5");
    expect(devBranchName("RES-12")).toBe("devflow/RES-12");
    for (const key of ["", "a b", "x/../y", "-x", "a;b", "x".repeat(60)]) expect(() => devBranchName(key), key).toThrow();
  });

  describe("workspace folder", () => {
    const system = { key: "portal", repoUrl: REPO, defaultBranch: "main", tokenSecretId: "secret-1" };
    const ws = (resolveToken: (c: string, s: string) => Promise<string | null> = async () => TOKEN) =>
      devWorkspace({ root: path.join(tmp, "ws"), resolveToken, env: via() });

    it("is a git repository with one empty commit, so Paperclip can ship the repositories inside it", async () => {
      const w = ws();
      await w.reset();
      expect(w.dir).toBe(path.join(tmp, "ws", "dev"));
      expect(git(w.dir, "rev-list", "--count", "HEAD")).toBe("1");
      expect(git(w.dir, "log", "-1", "--format=%an")).toBe("DevFlow Dev");
      const exclude = fs.readFileSync(path.join(w.dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain("/.devflow/");
      expect(exclude).toContain(`/${REPOS_DIR}/`);
      await w.writeRequest("# Request");
      expect(fs.readFileSync(path.join(w.dir, ".devflow", "request.md"), "utf8")).toBe("# Request");
      expect(git(w.dir, "status", "--porcelain")).toBe(""); // neither request.md nor the repositories dirty the anchor
    });

    it("puts each system under .paperclip-repositories and empties the folder afterwards", async () => {
      const w = ws();
      await w.reset();
      const prepared = await w.prepareAll("company-1", "REQ-5", [system]);
      expect(prepared).toEqual([{ key: "portal", branch: "devflow/REQ-5", baseBranch: "main", sha: mainSha, resumed: false }]);
      expect(git(path.join(w.dir, REPOS_DIR, "portal"), "branch", "--show-current")).toBe("devflow/REQ-5");
      expect(git(w.dir, "status", "--porcelain")).toBe("");
      await w.clear();
      expect(fs.existsSync(w.dir)).toBe(false);
      await w.reset(); // a second case starts from nothing
      expect(fs.readdirSync(w.dir).sort()).toEqual([".devflow", ".git"]);
    });

    it("keeps QA in its own folder, on the branch of the pull request, and stops with branch_missing when it is gone", async () => {
      const qa = devWorkspace({ root: path.join(tmp, "ws"), resolveToken: async () => TOKEN, env: via(), role: "qa" });
      await qa.reset();
      expect(qa.dir).toBe(path.join(tmp, "ws", "qa"));
      const prepared = await qa.prepareAll("c", "REQ-7", [system]);
      expect(prepared).toEqual([{ key: "portal", branch: "devflow/REQ-7", baseBranch: "main", sha: resumedSha, resumed: true }]);
      expect(git(path.join(qa.dir, REPOS_DIR, "portal"), "branch", "--show-current")).toBe("devflow/REQ-7");
      await qa.clear();
      await qa.reset();
      await expect(qa.prepareAll("c", "REQ-99", [system])).rejects.toMatchObject({ kind: "branch_missing" });
      expect(fs.existsSync(path.join(qa.dir, REPOS_DIR, "portal"))).toBe(false);
    });

    it("stops with system_missing_token when the secret is gone, and with clone_failed when git fails", async () => {
      const noToken = ws(async () => null);
      await noToken.reset();
      await expect(noToken.prepareAll("c", "REQ-5", [system])).rejects.toMatchObject({ kind: "system_missing_token" });
      const w = ws();
      await w.reset();
      await expect(w.prepareAll("c", "REQ-5", [{ ...system, defaultBranch: "nope" }])).rejects.toBeInstanceOf(StageFailure);
      await expect(w.prepareAll("c", "REQ-5", [{ ...system, defaultBranch: "nope" }])).rejects.toMatchObject({ kind: "clone_failed" });
      expect(fs.existsSync(path.join(w.dir, REPOS_DIR, "portal"))).toBe(false);
    });

    it("reads the token with the company and secret of the system, not from anywhere else", async () => {
      const seen: string[][] = [];
      const w = ws(async (c, s) => {
        seen.push([c, s]);
        return TOKEN;
      });
      await w.reset();
      await w.prepareAll("company-9", "REQ-5", [system]);
      expect(seen).toEqual([["company-9", "secret-1"]]);
      const open = ws(async () => {
        throw new Error("must not be asked for a public repository");
      });
      await open.reset();
      await open.prepareAll("c", "REQ-5", [{ ...system, tokenSecretId: null }]);
    });
  });
});
