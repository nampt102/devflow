import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GITHUB_REPO } from "./service.js";

const run = promisify(execFile);

// Clones a system's repository for the BA agent to read (change add-ba-spec-stage, design D2). The agent is
// hostile-input territory: the repository content is not trusted, and the token must not outlive the clone.
//  - the token goes in an HTTP header for this one git process (never in the URL, never in .git/config),
//  - git may only speak https, run no hooks and ask no questions,
//  - the origin remote is removed after the clone,
//  - symlinks are deleted, so a repository cannot point the agent's Read tool at files outside the workspace.

export type CloneInput = {
  repoUrl: string;
  branch: string;
  dest: string;
  /** read-only token; omitted for a public repository */
  token?: string | null;
  /** git executable and environment, replaceable in tests */
  gitBin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type CloneResult = { sha: string };

export const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

/** `-c` arguments that send the token in an HTTP header for one git process (never in the URL or .git/config). */
export function authHeaderArgs(token?: string | null): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/** The minimal environment of a git process: https only, no prompts, no system config. */
export function gitRunEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

export function cloneArgs(input: Pick<CloneInput, "repoUrl" | "branch" | "dest" | "token">): string[] {
  // the same checks the catalog applies; repeated here because this is where the command line is built
  if (!GITHUB_REPO.test(input.repoUrl)) throw new Error("Repository URL must be a plain https://github.com/<owner>/<repo> URL");
  if (!BRANCH.test(input.branch) || input.branch.includes("..")) throw new Error("Invalid branch name");
  const args: string[] = ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false"];
  args.push(...authHeaderArgs(input.token));
  // `--` ends the options, so no field can be read as one
  args.push("clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", input.branch, "--", input.repoUrl, input.dest);
  return args;
}

/** Deletes every symlink under `dir` (not following them) and returns how many were removed. */
export async function removeSymlinks(dir: string): Promise<number> {
  let removed = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await fs.unlink(full);
      removed += 1;
    } else if (entry.isDirectory() && entry.name !== ".git") {
      removed += await removeSymlinks(full);
    }
  }
  return removed;
}

export async function cloneSystem(input: CloneInput): Promise<CloneResult> {
  const git = input.gitBin ?? "git";
  const opts = {
    timeout: input.timeoutMs ?? 120_000,
    maxBuffer: 1024 * 1024,
    env: gitRunEnv(input.env),
  };
  try {
    await run(git, cloneArgs(input), opts);
    const { stdout } = await run(git, ["-C", input.dest, "rev-parse", "HEAD"], opts);
    await run(git, ["-C", input.dest, "remote", "remove", "origin"], opts);
    await removeSymlinks(input.dest);
    return { sha: stdout.trim() };
  } catch (error) {
    // git's message can echo the URL and headers; keep only that it failed
    const timedOut = (error as { killed?: boolean }).killed === true;
    await fs.rm(input.dest, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(timedOut ? "clone_timeout" : "clone_failed");
  }
}
