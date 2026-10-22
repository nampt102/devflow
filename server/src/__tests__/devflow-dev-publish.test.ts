import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkDiff, DiffCheckError, globToRegExp, isForbiddenPath, MAX_BINARY_BYTES } from "../devflow/dev/diff-check.js";
import { GithubError, githubClient, pushBranch, type GithubClient } from "../devflow/dev/github.js";
import { DevPublishError, prBody, prTitle, publishRepo, type PublishInput } from "../devflow/dev/publish.js";

// Checking the Dev agent's commits and publishing them (openspec/changes/add-dev-stage, task 3.5): real git
// repositories in a temp folder, a fake GitHub.
const REPO = "https://github.com/acme/hr-portal";
const TOKEN = "ghp_WRITETOKEN_abc123";
const BRANCH = "devflow/REQ-5";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-publish-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** A repository with a base commit and the request's branch checked out. */
function repo() {
  const dir = path.join(tmp, `repo${++n}`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "src", "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", BRANCH);
  const commit = (files: Record<string, string | Buffer>, message = "work") => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
  };
  return { dir, baseSha, commit };
}
const check = (r: { dir: string; baseSha: string }, over: Record<string, unknown> = {}) =>
  checkDiff({ repoDir: r.dir, baseSha: r.baseSha, branch: BRANCH, ...over });
const kind = async (p: Promise<unknown>) => (await p.then(() => null, (e: DiffCheckError) => e)) as DiffCheckError | null;

describe("forbidden path patterns", () => {
  it("matches by basename without a slash, from the root with one, ignoring case", () => {
    const f = (file: string, ...patterns: string[]) => isForbiddenPath(file, patterns);
    expect(f(".env", ".env*")).toBe(true);
    expect(f("backend/config/.env.production", ".env*")).toBe(true);
    expect(f("src/environment.ts", ".env*")).toBe(false);
    expect(f("certs/server.PEM", "*.pem")).toBe(true);
    expect(f("src/keyboard.keys.ts", "*.key")).toBe(false);
    expect(f("deploy/prod/values.yml", "deploy/**")).toBe(true);
    expect(f("src/deploy/x.yml", "deploy/**")).toBe(false);
    expect(f(".GitHub/Workflows/ci.yml", ".github/workflows/**")).toBe(true);
    expect(f("Jenkinsfile", "Jenkinsfile")).toBe(true);
    expect(globToRegExp("a/*.md").test("a/b/c.md")).toBe(false);
  });
});

describe("diff check", () => {
  it("returns null when the agent made no commit, and ignores what is only in the work tree", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r.dir, ".env"), "SECRET=1\n"); // not committed: never pushed, so not looked at
    expect(await check(r)).toBeNull();
  });

  it("counts the commits, files and lines of an acceptable change", async () => {
    const r = repo();
    r.commit({ "src/a.txt": "one\nTWO\nthree\nfour\n", "src/new.ts": "export const x = 1;\n" }, "first");
    r.commit({ "src/other.ts": "export const y = 2;\n" }, "second");
    const s = await check(r);
    expect(s).toMatchObject({ baseSha: r.baseSha, commits: 2, filesChanged: 3, additions: 4, deletions: 1 });
    expect(s!.headSha).toBe(git(r.dir, "rev-parse", "HEAD"));
    expect(s!.files.sort()).toEqual(["src/a.txt", "src/new.ts", "src/other.ts"]);
  });

  it("refuses commits made on another branch", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    git(r.dir, "checkout", "-q", "main");
    expect((await kind(check(r)))?.kind).toBe("wrong_branch");
    git(r.dir, "checkout", "-q", "--detach", "HEAD");
    expect((await kind(check(r)))?.kind).toBe("wrong_branch");
  });

  it("refuses a rewritten history", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" }, "second");
    const second = git(r.dir, "rev-parse", "HEAD");
    git(r.dir, "reset", "-q", "--hard", "HEAD~1");
    r.commit({ "src/y.ts": "y\n" }, "replacement");
    expect((await kind(check({ dir: r.dir, baseSha: second })))?.kind).toBe("history_rewritten");
    expect((await kind(check({ dir: r.dir, baseSha: "not-a-sha" })))?.kind).toBe("diff_failed");
  });

  it.each([
    [".github/workflows/deploy.yml", []],
    [".GITHUB/Workflows/deploy.yml", []],
    ["backend/.env.local", []],
    ["certs/server.pem", []],
    ["keys/id_rsa", []],
    ["Jenkinsfile", []],
    ["deploy/prod/values.yml", ["deploy/**"]],
  ])("refuses a change to %s and names it", async (file, extra) => {
    const r = repo();
    r.commit({ "src/ok.ts": "ok\n", [file]: "x\n" });
    const e = await kind(check(r, { extraForbiddenPaths: extra }));
    expect(e).toMatchObject({ kind: "forbidden_paths" });
    expect(e!.paths).toEqual([file]);
  });

  it("looks at the paths of a rename, so a file cannot be moved onto a forbidden name", async () => {
    const r = repo();
    git(r.dir, "mv", "src/a.txt", ".env");
    git(r.dir, "commit", "-q", "-m", "rename");
    expect((await kind(check(r)))?.kind).toBe("forbidden_paths");
  });

  it("refuses a change that is too large and counts both added and deleted lines", async () => {
    const r = repo();
    r.commit({ "src/big.txt": Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n" });
    expect((await kind(check(r, { maxLines: 39 })))?.kind).toBe("diff_too_large");
    expect(await check(r, { maxLines: 40 })).toMatchObject({ additions: 40 });
    const d = repo();
    d.commit({ "src/a.txt": "" }); // deletes 3 lines
    expect(await check(d, { maxLines: 3 })).toMatchObject({ deletions: 3 });
    expect((await kind(check(d, { maxLines: 2 })))?.kind).toBe("diff_too_large");
  });

  it("allows a small binary file, refuses one over 1 MB, and does not mind deleting a big one", async () => {
    const small = repo();
    small.commit({ "assets/logo.bin": Buffer.from([0, 1, 2, 3, 0, 255]) });
    expect(await check(small)).toMatchObject({ filesChanged: 1, additions: 0 });
    const big = repo();
    big.commit({ "assets/big.bin": Buffer.alloc(MAX_BINARY_BYTES + 1, 0) });
    const e = await kind(check(big));
    expect(e).toMatchObject({ kind: "binary_too_large" });
    expect(e!.paths).toEqual(["assets/big.bin"]);
    const del = repo();
    del.commit({ "assets/big.bin": Buffer.alloc(MAX_BINARY_BYTES + 1, 0) });
    const withBig = git(del.dir, "rev-parse", "HEAD");
    git(del.dir, "rm", "-q", "assets/big.bin");
    git(del.dir, "commit", "-q", "-m", "remove");
    expect((await check({ dir: del.dir, baseSha: withBig }))?.filesChanged).toBe(1);
  });

  it("refuses a submodule", async () => {
    const r = repo();
    git(r.dir, "update-index", "--add", "--cacheinfo", `160000,${r.baseSha},vendor/lib`);
    git(r.dir, "commit", "-q", "-m", "submodule");
    expect((await kind(check(r)))?.kind).toBe("submodule_change");
  });
});

describe("GitHub client", () => {
  type Call = { method: string; url: string; body: unknown; auth: string | null };
  function fake(responses: Record<string, { status: number; json?: unknown }>) {
    const calls: Call[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null });
      const key = Object.keys(responses).find((k) => `${init.method} ${url}`.startsWith(`${k}`));
      const r = key ? responses[key]! : { status: 500 };
      return { status: r.status, json: async () => r.json } as Response;
    }) as unknown as typeof fetch;
    return { calls, client: githubClient(TOKEN, fetchFn) };
  }

  it("reads permissions and branch protection, with the token only in the Authorization header", async () => {
    const { calls, client } = fake({
      "GET https://api.github.com/repos/acme/hr-portal/branches/main": { status: 200, json: { protected: true } },
      "GET https://api.github.com/repos/acme/hr-portal": { status: 200, json: { permissions: { push: true } } },
    });
    expect(await client.isBranchProtected(REPO, "main")).toBe(true);
    expect(await client.canPush(REPO)).toBe(true);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
    const { client: unprotected } = fake({ "GET https://api.github.com/repos/acme/hr-portal/branches/main": { status: 200, json: { protected: false } } });
    expect(await unprotected.isBranchProtected(REPO, "main")).toBe(false);
  });

  it("opens the pull request as a draft and finds it again by its branch", async () => {
    const { calls, client } = fake({
      "POST https://api.github.com/repos/acme/hr-portal/pulls": { status: 201, json: { number: 7, html_url: "https://github.com/acme/hr-portal/pull/7", draft: true } },
      "GET https://api.github.com/repos/acme/hr-portal/pulls?": { status: 200, json: [{ number: 7, html_url: "https://github.com/acme/hr-portal/pull/7", draft: true }] },
    });
    expect(await client.createDraftPr(REPO, { title: "t", body: "b", head: BRANCH, base: "main" })).toEqual({ number: 7, url: "https://github.com/acme/hr-portal/pull/7", draft: true });
    expect(calls[0]!.body).toMatchObject({ draft: true, head: BRANCH, base: "main" });
    expect((await client.findOpenPr(REPO, BRANCH))?.number).toBe(7);
    expect(calls[1]!.url).toContain(`head=${encodeURIComponent(`acme:${BRANCH}`)}`);
  });

  it("maps HTTP failures to kinds that carry no token or GitHub text", async () => {
    for (const [status, expected] of [[401, "github_auth"], [403, "github_forbidden"], [404, "github_forbidden"], [422, "github_rejected"], [500, "github_error"]] as const) {
      const { client } = fake({ "GET ": { status, json: { message: `bad credentials ${TOKEN}` } } });
      const e = (await client.canPush(REPO).catch((x) => x)) as GithubError;
      expect(e).toBeInstanceOf(GithubError);
      expect(e.kind).toBe(expected);
      expect(`${e.message}${e.stack}`).not.toContain(TOKEN);
    }
    await expect(githubClient(TOKEN).canPush("http://github.com/a/b")).rejects.toMatchObject({ kind: "github_rejected" });
  });
});

describe("push", () => {
  it("pushes HEAD to the request's branch only, with the token in a header and not in the command line", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const bare = path.join(tmp, `bare${++n}.git`);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const env = { GIT_ALLOW_PROTOCOL: "file:https", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: REPO };
    await pushBranch({ repoDir: r.dir, repoUrl: REPO, branch: BRANCH, token: TOKEN, env });
    expect(git(bare, "rev-parse", `refs/heads/${BRANCH}`)).toBe(git(r.dir, "rev-parse", "HEAD"));
    expect(git(bare, "branch", "--list").replace(/[* ]/g, "")).toBe(BRANCH);
    // a second run adds to the same branch
    r.commit({ "src/y.ts": "y\n" });
    await pushBranch({ repoDir: r.dir, repoUrl: REPO, branch: BRANCH, token: TOKEN, env });
    expect(git(bare, "rev-parse", `refs/heads/${BRANCH}`)).toBe(git(r.dir, "rev-parse", "HEAD"));
    // a history that does not continue the remote one is refused, never forced
    git(r.dir, "reset", "-q", "--hard", "HEAD~2");
    r.commit({ "src/z.ts": "z\n" });
    await expect(pushBranch({ repoDir: r.dir, repoUrl: REPO, branch: BRANCH, token: TOKEN, env })).rejects.toMatchObject({ kind: "push_rejected" });
  });

  it("never pushes to a branch that is not devflow/*, or to a URL the catalog would not allow", async () => {
    const r = repo();
    for (const branch of ["main", "devflow/../main", "devflow/a b", "refs/heads/main", "--delete"]) {
      await expect(pushBranch({ repoDir: r.dir, repoUrl: REPO, branch, token: TOKEN }), branch).rejects.toMatchObject({ kind: "push_rejected" });
    }
    await expect(pushBranch({ repoDir: r.dir, repoUrl: "https://evil.test/a/b", branch: BRANCH, token: TOKEN })).rejects.toBeInstanceOf(GithubError);
  });

  it("reports a failed push without the token", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const e = (await pushBranch({ repoDir: r.dir, repoUrl: REPO, branch: BRANCH, token: TOKEN, env: { GIT_ALLOW_PROTOCOL: "file" } }).catch((x) => x)) as GithubError;
    expect(e.kind).toBe("push_failed");
    expect(`${e.message}${e.stack}`).not.toContain(TOKEN);
  });
});

describe("publish", () => {
  const report: PublishInput["report"] = {
    summary: "Đã thêm tên người xử lý. Cc @mallory để xem.",
    tasks: [{ id: "T1", status: "done", notes: "Xong và đã commit." }],
    checks: [{ system: "portal", command: "npm test", passed: true, outputTail: "4 passed" }],
    risks: [],
    openQuestions: ["Có cần hiện cho khách không?"],
  };
  const system = { key: "portal", repoUrl: REPO, defaultBranch: "main", allowUnprotected: false, forbiddenPaths: [] as string[] };

  function world(opts: { protected?: boolean; canPush?: boolean; existingPr?: number | null; pushError?: GithubError } = {}) {
    const log: string[] = [];
    const bodies: { title?: string; body?: string; comment?: string } = {};
    const github = {
      canPush: async () => (log.push("canPush"), opts.canPush ?? true),
      isBranchProtected: async () => (log.push("protected"), opts.protected ?? true),
      findOpenPr: async () => (log.push("find"), opts.existingPr ? { number: opts.existingPr, url: `https://github.com/acme/hr-portal/pull/${opts.existingPr}`, draft: true } : null),
      createDraftPr: async (_u: string, i: { title: string; body: string }) => (log.push("create"), Object.assign(bodies, i), { number: 9, url: "https://github.com/acme/hr-portal/pull/9", draft: true }),
      updatePr: async (_u: string, number: number, i: { title?: string; body?: string }) => (log.push("update"), Object.assign(bodies, i), { number, url: `https://github.com/acme/hr-portal/pull/${number}`, draft: true }),
      comment: async (_u: string, _n: number, body: string) => (log.push("comment"), void (bodies.comment = body)),
      label: async () => void log.push("label"),
    } as unknown as GithubClient;
    const deps = {
      github: () => (log.push("github"), github),
      push: async () => {
        log.push("push");
        if (opts.pushError) throw opts.pushError;
      },
    };
    return { log, bodies, deps };
  }
  const input = (r: { dir: string; baseSha: string }, over: Partial<PublishInput> = {}): PublishInput => ({
    system,
    repoDir: r.dir,
    branch: BRANCH,
    baseSha: r.baseSha,
    writeToken: TOKEN,
    caseKey: "REQ-5",
    title: "Hiện tên\nngười xử lý",
    report,
    caseUrl: "https://devflow.example/requests/5",
    ...over,
  });
  const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: DevPublishError) => e)) as DevPublishError;

  it("pushes the branch and opens a draft pull request that DevFlow never merges", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const w = world();
    const out = await publishRepo(input(r), w.deps);
    expect(w.log).toEqual(["github", "canPush", "protected", "push", "find", "create", "label"]);
    expect(out).toMatchObject({ system: "portal", branch: BRANCH, baseBranch: "main", commits: 1, filesChanged: 1, prNumber: 9, newPr: true, unprotectedWarning: false });
    expect(out!.headSha).toBe(git(r.dir, "rev-parse", "HEAD"));
    expect(w.bodies.title).toBe("[REQ-5] Hiện tên người xử lý");
    expect(w.bodies.body).toContain("✅ `npm test`");
    expect(w.bodies.body).toContain("https://devflow.example/requests/5");
  });

  it("does not ping people from the agent's words", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const w = world();
    await publishRepo(input(r), w.deps);
    expect(w.bodies.body).not.toMatch(/(^|[^\w])@mallory/);
    expect(w.bodies.body).toContain("@​mallory");
    expect(prTitle("REQ-5", "cc @bob\nnow")).toBe("[REQ-5] cc @​bob now");
    expect(prBody({ caseKey: "REQ-5", report, summary: { baseSha: "a", headSha: "b", commits: 1, filesChanged: 1, additions: 1, deletions: 0, files: [] }, unprotectedWarning: false, baseBranch: "main" }).length).toBeLessThan(60_000);
  });

  it("updates the pull request of an earlier run and says what the new run did", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const w = world({ existingPr: 3 });
    const out = await publishRepo(input(r), w.deps);
    expect(w.log).toEqual(["github", "canPush", "protected", "push", "find", "update", "comment"]);
    expect(out).toMatchObject({ prNumber: 3, newPr: false });
    expect(w.bodies.comment).toContain("Lượt chạy mới");
  });

  it("does nothing when the agent made no commit", async () => {
    const r = repo();
    const w = world();
    expect(await publishRepo(input(r), w.deps)).toBeNull();
    expect(w.log).toEqual([]);
  });

  it("pushes nothing when the diff fails the checks, and does not even contact GitHub", async () => {
    const r = repo();
    r.commit({ ".github/workflows/deploy.yml": "name: x\n" });
    const w = world();
    const e = await err(publishRepo(input(r), w.deps));
    expect(e).toMatchObject({ kind: "forbidden_paths", paths: [".github/workflows/deploy.yml"] });
    expect(w.log).toEqual([]);
    const big = repo();
    big.commit({ "src/big.txt": "x\n".repeat(50) });
    expect((await err(publishRepo(input(big, { maxLines: 10 }), w.deps))).kind).toBe("diff_too_large");
    const extra = repo();
    extra.commit({ "deploy/a.yml": "x\n" });
    expect((await err(publishRepo(input(extra, { system: { ...system, forbiddenPaths: ["deploy/**"] } }), w.deps))).kind).toBe("forbidden_paths");
    expect(w.log).toEqual([]);
  });

  it("refuses an unprotected default branch before pushing, unless the owner accepted it", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const refused = world({ protected: false });
    expect((await err(publishRepo(input(r), refused.deps))).kind).toBe("repo_unprotected");
    expect(refused.log).not.toContain("push");
    const accepted = world({ protected: false });
    const out = await publishRepo(input(r, { system: { ...system, allowUnprotected: true } }), accepted.deps);
    expect(out!.unprotectedWarning).toBe(true);
    expect(accepted.log).toContain("push");
    expect(accepted.bodies.body).toContain("không được bảo vệ");
  });

  it("refuses a write token that cannot push, and passes on GitHub and push failures as kinds", async () => {
    const r = repo();
    r.commit({ "src/x.ts": "x\n" });
    const noPush = world({ canPush: false });
    expect((await err(publishRepo(input(r), noPush.deps))).kind).toBe("write_token_cannot_push");
    expect(noPush.log).not.toContain("push");
    const rejected = world({ pushError: new GithubError("push_rejected") });
    expect((await err(publishRepo(input(r), rejected.deps))).kind).toBe("push_rejected");
    const failing = world();
    (failing.deps as any).github = () => ({ canPush: async () => { throw new GithubError("github_auth", 401); } });
    const e = await err(publishRepo(input(r), failing.deps as any));
    expect(e.kind).toBe("github_auth");
    expect(`${e.message}${e.stack}`).not.toContain(TOKEN);
  });
});

