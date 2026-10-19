import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cloneArgs, cloneSystem, removeSymlinks } from "../devflow/systems/workspace.js";
import { secretService } from "../services/secrets.js";

// Cloning a system's repository for the BA agent (openspec/changes/add-ba-spec-stage, task 2.3).
const REPO = "https://github.com/acme/hr-portal";
const TOKEN = "ghp_TESTTOKEN_abc123";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

describe("clone command line", () => {
  it("passes the token in a header for this process only and ends the options before the URL", () => {
    const args = cloneArgs({ repoUrl: REPO, branch: "main", dest: "/work/repo", token: TOKEN });
    const header = args.find((a) => a.startsWith("http.extraHeader="));
    expect(header).toBe(`http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.indexOf("--")).toBeGreaterThan(args.indexOf("clone"));
    expect(args.indexOf("--")).toBe(args.indexOf(REPO) - 1);
    expect(args).toEqual(expect.arrayContaining(["--depth", "1", "--single-branch", "--no-tags", "core.hooksPath=/dev/null"]));
  });

  it("sends no header for a public repository", () => {
    expect(cloneArgs({ repoUrl: REPO, branch: "main", dest: "/w", token: null }).some((a) => a.includes("extraHeader"))).toBe(false);
  });

  it("refuses a URL or branch that is not what the catalog allows", () => {
    for (const repoUrl of ["http://github.com/a/b", "https://evil.test/a/b", "https://github.com/a/b --upload-pack=x", "file:///etc", "ext::sh -c x", "https://u:p@github.com/a/b"]) {
      expect(() => cloneArgs({ repoUrl, branch: "main", dest: "/w" }), repoUrl).toThrow();
    }
    for (const branch of ["--upload-pack=x", "-b", "a..b", "a b", "a;b", ""]) {
      expect(() => cloneArgs({ repoUrl: REPO, branch, dest: "/w" }), branch).toThrow();
    }
  });
});

describe("cloneSystem", () => {
  let tmp: string;
  let origin: string;
  let headSha: string;
  const via = (extra: Record<string, string> = {}) => ({
    GIT_ALLOW_PROTOCOL: "file:https",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: REPO,
    ...extra,
  });

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-clone-"));
    origin = path.join(tmp, "origin");
    fs.mkdirSync(path.join(origin, "docs"), { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "docs", "rules.md"), "# Quy tắc\n");
    fs.writeFileSync(path.join(tmp, "outside-secret.txt"), "outside\n");
    fs.symlinkSync(path.join(tmp, "outside-secret.txt"), path.join(origin, "docs", "link-to-outside"));
    fs.symlinkSync("/etc", path.join(origin, "etc-link"));
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "init");
    git(origin, "checkout", "-q", "-b", "develop");
    fs.writeFileSync(path.join(origin, "docs", "dev.md"), "dev\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "dev");
    headSha = git(origin, "rev-parse", "HEAD");
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("clones the branch shallowly and returns the commit it read", async () => {
    const dest = path.join(tmp, "ws1");
    const { sha } = await cloneSystem({ repoUrl: REPO, branch: "develop", dest, token: TOKEN, env: via() });
    expect(sha).toBe(headSha);
    expect(fs.readFileSync(path.join(dest, "docs", "dev.md"), "utf8")).toBe("dev\n");
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("leaves no token, no remote and no symlink behind", async () => {
    const dest = path.join(tmp, "ws2");
    await cloneSystem({ repoUrl: REPO, branch: "main", dest, token: TOKEN, env: via() });
    expect(git(dest, "remote")).toBe("");
    const grep = (() => {
      try {
        return execFileSync("grep", ["-rIl", TOKEN, dest], { encoding: "utf8" });
      } catch {
        return ""; // grep exits 1 when nothing matches
      }
    })();
    expect(grep).toBe("");
    const links: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isSymbolicLink()) links.push(path.join(d, e.name));
        else if (e.isDirectory() && e.name !== ".git") walk(path.join(d, e.name));
      }
    };
    walk(dest);
    expect(links).toEqual([]);
    expect(fs.existsSync(path.join(dest, "docs", "rules.md"))).toBe(true);
  });

  it("removeSymlinks does not follow links and counts what it removed", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "sl-"));
    fs.mkdirSync(path.join(dir, "a"));
    fs.symlinkSync(tmp, path.join(dir, "a", "loop"));
    fs.symlinkSync("nowhere", path.join(dir, "dangling"));
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    expect(await removeSymlinks(dir)).toBe(2);
    expect(fs.existsSync(tmp)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(["a", "keep.txt"]);
  });

  it("gives git a minimal environment: the server's secrets are not passed on", async () => {
    const record = path.join(tmp, "record.json");
    const fake = path.join(tmp, "fake-git.sh");
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}.args"\nenv > "${record}.env"\nmkdir -p "$(eval echo \\$$#)" 2>/dev/null\nexit 0\n`, { mode: 0o755 });
    process.env.DEVFLOW_SMTP_PASS = "server-secret-do-not-leak";
    try {
      await cloneSystem({ repoUrl: REPO, branch: "main", dest: path.join(tmp, "ws3"), token: TOKEN, gitBin: fake }).catch(() => undefined);
    } finally {
      delete process.env.DEVFLOW_SMTP_PASS;
    }
    const env = fs.readFileSync(`${record}.env`, "utf8");
    expect(env).not.toContain("server-secret-do-not-leak");
    expect(env).toContain("GIT_TERMINAL_PROMPT=0");
    expect(env).toContain("GIT_ALLOW_PROTOCOL=https");
    expect(fs.readFileSync(`${record}.args`, "utf8")).not.toContain(REPO + " ");
  });

  it("fails with a short reason that does not echo the token, and removes a half-made clone", async () => {
    const dest = path.join(tmp, "ws4");
    const error = await cloneSystem({ repoUrl: REPO, branch: "no-such-branch", dest, token: TOKEN, env: via() }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("clone_failed");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("removes what a clone that died half-way left behind", async () => {
    const half = path.join(tmp, "half-git.sh");
    fs.writeFileSync(half, `#!/bin/sh\nfor last; do :; done\nmkdir -p "$last" && echo partial > "$last/file"\nexit 128\n`, { mode: 0o755 });
    const dest = path.join(tmp, "ws6");
    const error = await cloneSystem({ repoUrl: REPO, branch: "main", dest, gitBin: half }).catch((e: Error) => e);
    expect((error as Error).message).toBe("clone_failed");
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("gives up after the timeout", async () => {
    const slow = path.join(tmp, "slow-git.sh");
    fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const error = await cloneSystem({ repoUrl: REPO, branch: "main", dest: path.join(tmp, "ws5"), gitBin: slow, timeoutMs: 200 }).catch((e: Error) => e);
    expect((error as Error).message).toBe("clone_timeout");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Task 2.3: the token a staff member stored can be read back by DevFlow's own code through the real secret service.
describeEmbeddedPostgres("reading a system's token through the real secret service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let keyDir: string;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;

  beforeAll(async () => {
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "devflow-secret-key-"));
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(keyDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("devflow-systems-secret-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    fs.rmSync(keyDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  const company = async (name: string) =>
    (await db.insert(companies).values({ name, issuePrefix: `P${randomUUID().replace(/[^a-z]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X")}` }).returning())[0]!;
  const system = { consumerType: "system" as const, consumerId: "devflow-systems", actorType: "system" as const, actorId: "devflow-ba" };

  it("resolves the stored token for its own company and refuses another company", async () => {
    const a = await company("Secret A");
    const b = await company("Secret B");
    const svc = secretService(db);
    const created = await svc.create(a.id, { name: "devflow-system-hr", provider: "local_encrypted", value: TOKEN }, { userId: "staff", agentId: null });
    expect(await svc.resolveSecretValue(a.id, created.id, "latest", { accessContext: system })).toBe(TOKEN);
    await expect(svc.resolveSecretValue(b.id, created.id, "latest", { accessContext: system })).rejects.toThrow(/same company/);
    await svc.remove(created.id);
    await expect(svc.resolveSecretValue(a.id, created.id, "latest", { accessContext: system })).rejects.toThrow();
  });
});
