import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StageFailure } from "../agent-stage/failure.js";
import { authHeaderArgs, BRANCH, gitRunEnv } from "../systems/workspace.js";
import { GITHUB_REPO } from "../systems/service.js";
import { DEV_GIT_EMAIL, DEV_GIT_NAME } from "./agent.js";
import { runnerWorkspaceDir, type RunnerRole } from "./runner-agent.js";

const run = promisify(execFile);

// The folder the Dev agent works in, on the server (openspec/changes/add-dev-stage, design D1 and D3). Paperclip copies
// it to the runner for every run and brings the new commits back. What the spike of 2026-10-22 showed about that:
//  - the folder itself must be a git repository (the "anchor", one empty commit); the repositories of the systems
//    live in `.paperclip-repositories/<key>/` and are shipped separately, as git bundles, in both directions;
//  - a bundle cannot be made from a shallow or partial clone, so the repositories are cloned in full;
//  - the repositories' local git config is not carried over, so the commit author comes from the agent's environment;
//  - `.devflow/request.md` travels as a plain file.
// Only the request being worked on is ever on disk: the folder is emptied before and after every run.

export const REPOS_DIR = ".paperclip-repositories";
const DEV_BRANCH = /^devflow\/[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;

/** The branch a request's code lives on: `devflow/<case key>`, e.g. devflow/REQ-5. */
export const devBranchName = (caseKey: string) => {
  const name = `devflow/${caseKey}`;
  if (!DEV_BRANCH.test(name)) throw new Error("Invalid request key for a branch name");
  return name;
};

export type DevRepoInput = {
  repoUrl: string;
  defaultBranch: string;
  devBranch: string;
  /** QA checks the branch of a pull request: when GitHub does not have it the clone stops with `branch_missing`, no new branch is made */
  existingOnly?: boolean;
  dest: string;
  /** read-only token; omitted for a public repository */
  token?: string | null;
  gitBin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};
export type DevRepoResult = {
  /** the commit this run starts from: the base branch head, or the head of the branch an earlier run pushed */
  sha: string;
  /** an earlier run already pushed the branch and this run continues it */
  resumed: boolean;
};

/**
 * Clones a system's repository in full on the request's branch: the branch itself when GitHub already has it (a run
 * after "request changes"), otherwise a new one from the base branch. The token goes in a header for one git process
 * only, no hooks run, and the origin remote is removed: DevFlow pushes by URL later, with the write token.
 */
export async function prepareDevRepo(input: DevRepoInput): Promise<DevRepoResult> {
  if (!GITHUB_REPO.test(input.repoUrl)) throw new Error("Repository URL must be a plain https://github.com/<owner>/<repo> URL");
  if (!BRANCH.test(input.defaultBranch) || input.defaultBranch.includes("..")) throw new Error("Invalid branch name");
  if (!DEV_BRANCH.test(input.devBranch)) throw new Error("Invalid branch name");
  const git = input.gitBin ?? "git";
  const opts = { timeout: input.timeoutMs ?? 600_000, maxBuffer: 4 * 1024 * 1024, env: gitRunEnv(input.env) };
  const hardened = ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", ...authHeaderArgs(input.token)];
  try {
    // `--` ends the options, so no field can be read as one
    const { stdout: remote } = await run(git, [...hardened, "ls-remote", "--heads", "--", input.repoUrl, `refs/heads/${input.devBranch}`], opts);
    const resumed = remote.trim() !== "";
    if (input.existingOnly && !resumed) throw new Error("branch_missing");
    await run(git, [...hardened, "clone", "--no-tags", "--branch", resumed ? input.devBranch : input.defaultBranch, "--", input.repoUrl, input.dest], opts);
    if (!resumed) await run(git, ["-C", input.dest, "checkout", "-q", "-b", input.devBranch], opts);
    const { stdout } = await run(git, ["-C", input.dest, "rev-parse", "HEAD"], opts);
    await run(git, ["-C", input.dest, "remote", "remove", "origin"], opts);
    await run(git, ["-C", input.dest, "config", "core.hooksPath", "/dev/null"], opts);
    return { sha: stdout.trim(), resumed };
  } catch (error) {
    // git's message can echo the URL and headers; keep only that it failed
    const timedOut = (error as { killed?: boolean }).killed === true;
    const missing = (error as Error).message === "branch_missing";
    await fs.rm(input.dest, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(missing ? "branch_missing" : timedOut ? "clone_timeout" : "clone_failed");
  }
}

export type DevWorkspaceSystem = { key: string; repoUrl: string; defaultBranch: string; tokenSecretId: string | null };
export type PreparedSystem = { key: string; branch: string; baseBranch: string; sha: string; resumed: boolean };

export function devWorkspace(opts: {
  root: string;
  /** reads the token of a system's secret; null when the secret is gone */
  resolveToken: (companyId: string, secretId: string) => Promise<string | null>;
  prepare?: typeof prepareDevRepo;
  gitBin?: string;
  env?: Record<string, string>;
  /** the folder and the clone mode differ: QA checks branches that exist, Dev starts or continues them */
  role?: RunnerRole;
}) {
  const role = opts.role ?? "dev";
  const dir = runnerWorkspaceDir(role, opts.root);
  const prepare = opts.prepare ?? prepareDevRepo;
  const git = opts.gitBin ?? "git";

  /** An empty folder that is a git repository with one empty commit, which Paperclip needs to ship the repositories. */
  async function reset() {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.join(dir, ".devflow"), { recursive: true });
      const env = gitRunEnv(opts.env);
      const inDir = (...args: string[]) => run(git, ["-C", dir, ...args], { env, timeout: 60_000 });
      await inDir("init", "-q", "-b", "main");
      await fs.writeFile(path.join(dir, ".git", "info", "exclude"), `/.devflow/\n/${REPOS_DIR}/\n`, "utf8");
      await inDir("-c", `user.name=${DEV_GIT_NAME}`, "-c", `user.email=${DEV_GIT_EMAIL}`, "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "devflow workspace");
    } catch {
      throw new StageFailure("workspace_failed");
    }
  }

  async function prepareAll(companyId: string, caseKey: string, systems: readonly DevWorkspaceSystem[]): Promise<PreparedSystem[]> {
    const branch = devBranchName(caseKey);
    const out: PreparedSystem[] = [];
    for (const s of systems) {
      let token: string | null = null;
      if (s.tokenSecretId) {
        token = await opts.resolveToken(companyId, s.tokenSecretId).catch(() => null);
        if (!token) throw new StageFailure("system_missing_token");
      }
      try {
        const { sha, resumed } = await prepare({
          repoUrl: s.repoUrl,
          defaultBranch: s.defaultBranch,
          devBranch: branch,
          existingOnly: role === "qa",
          dest: path.join(dir, REPOS_DIR, s.key),
          token,
          gitBin: opts.gitBin,
          env: opts.env,
        });
        out.push({ key: s.key, branch, baseBranch: s.defaultBranch, sha, resumed });
      } catch (err) {
        const m = (err as Error).message;
        throw new StageFailure(m === "clone_timeout" ? "clone_timeout" : m === "branch_missing" ? "branch_missing" : "clone_failed");
      }
    }
    return out;
  }

  async function writeRequest(text: string) {
    await fs.writeFile(path.join(dir, ".devflow", "request.md"), text, "utf8").catch(() => {
      throw new StageFailure("workspace_failed");
    });
  }

  async function clear() {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { dir, reset, prepareAll, writeRequest, clear };
}
