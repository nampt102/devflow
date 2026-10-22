import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitRunEnv } from "../systems/workspace.js";

const run = promisify(execFile);

// What DevFlow checks in the commits the Dev agent made before anything leaves the server (openspec/changes/add-dev-stage,
// design D3). The agent is not trusted: its commits are looked at as data, with `git diff <base>..HEAD` only. After
// Paperclip brings commits back from the runner the index and the work tree of the repository can disagree with HEAD
// (spike), so neither is read.

export const DEFAULT_MAX_DIFF_LINES = 3000;
export const MAX_BINARY_BYTES = 1024 * 1024;

/** Files the agent never changes: CI and deployment, environment files, keys. A path without "/" matches at any depth. */
export const DEFAULT_FORBIDDEN_PATHS = [
  ".github/workflows/**",
  ".github/actions/**",
  ".circleci/**",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
  ".env*",
  "*.pem",
  "*.key",
  "*.pfx",
  "id_rsa*",
  ".gitmodules",
];

export type DiffFailureKind = "wrong_branch" | "history_rewritten" | "forbidden_paths" | "diff_too_large" | "binary_too_large" | "submodule_change" | "diff_failed";

/** The kind is the reason shown to the reviewer; `paths` are file names from the repository (data, not secrets). */
export class DiffCheckError extends Error {
  constructor(readonly kind: DiffFailureKind, readonly paths: readonly string[] = []) {
    super(`diff ${kind}`);
    this.name = "DiffCheckError";
  }
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

/** `**` crosses folders, `*` stays in one path segment; compared in lower case. */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.toLowerCase();
  const body = p
    .split("**")
    .map((part) => part.split("*").map(escapeRe).join("[^/]*"))
    .join(".*");
  return new RegExp(p.includes("/") ? `^${body}$` : `(^|/)${body}$`);
}

export const isForbiddenPath = (file: string, patterns: readonly string[]) => {
  const lower = file.toLowerCase();
  return patterns.some((pattern) => globToRegExp(pattern).test(lower));
};

export type DiffInput = {
  repoDir: string;
  /** the commit the run started from */
  baseSha: string;
  /** the branch that must be checked out */
  branch: string;
  /** the system's extra forbidden paths, on top of the defaults */
  extraForbiddenPaths?: readonly string[];
  maxLines?: number;
  gitBin?: string;
};

export type DiffSummary = {
  baseSha: string;
  headSha: string;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  files: string[];
};

const SHA = /^[0-9a-f]{40}$/;

/** The summary of the agent's commits, or null when it made none. Throws DiffCheckError when they must not be pushed. */
export async function checkDiff(input: DiffInput): Promise<DiffSummary | null> {
  if (!SHA.test(input.baseSha)) throw new DiffCheckError("diff_failed");
  const git = input.gitBin ?? "git";
  const opts = { env: gitRunEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 120_000 };
  const g = async (...args: string[]) => (await run(git, ["-C", input.repoDir, ...args], opts)).stdout;
  try {
    // the agent must have stayed on its branch: HEAD is read as a ref, not as whatever branch name is displayed
    const branch = (await g("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
    if (branch !== input.branch) throw new DiffCheckError("wrong_branch");
    const headSha = (await g("rev-parse", "HEAD")).trim();
    if (headSha === input.baseSha) return null;
    // no reset, rebase or amend of commits that already existed
    await g("merge-base", "--is-ancestor", input.baseSha, headSha).catch(() => {
      throw new DiffCheckError("history_rewritten");
    });
    const commits = Number((await g("rev-list", "--count", `${input.baseSha}..${headSha}`)).trim());

    // modes and paths (renames are shown as a delete and an add so both paths are checked)
    const raw = (await g("diff", "--raw", "-z", "--no-renames", "--no-abbrev", input.baseSha, headSha)).split("\0");
    const entries: { path: string; mode: string; status: string; blob: string }[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = raw[i]!.split(/[ \t]+/); // :oldmode newmode oldsha newsha status
      entries.push({ path: raw[i + 1]!, mode: meta[1] ?? "", status: meta[4] ?? "", blob: meta[3] ?? "" });
    }
    const files = entries.map((e) => e.path);
    if (entries.some((e) => e.mode === "160000")) throw new DiffCheckError("submodule_change", entries.filter((e) => e.mode === "160000").map((e) => e.path));
    const forbidden = [...DEFAULT_FORBIDDEN_PATHS, ...(input.extraForbiddenPaths ?? [])];
    const hit = files.filter((f) => isForbiddenPath(f, forbidden));
    if (hit.length) throw new DiffCheckError("forbidden_paths", hit);

    let additions = 0;
    let deletions = 0;
    const binaries: string[] = [];
    const num = (await g("diff", "--numstat", "-z", "--no-renames", input.baseSha, headSha)).split("\0");
    for (const row of num) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(row);
      if (!m) continue;
      if (m[1] === "-") binaries.push(m[3]!);
      else {
        additions += Number(m[1]);
        deletions += Number(m[2]);
      }
    }
    const maxLines = input.maxLines ?? DEFAULT_MAX_DIFF_LINES;
    if (additions + deletions > maxLines) throw new DiffCheckError("diff_too_large");
    for (const e of entries.filter((x) => binaries.includes(x.path) && x.status !== "D")) {
      const size = Number((await g("cat-file", "-s", e.blob)).trim());
      if (size > MAX_BINARY_BYTES) throw new DiffCheckError("binary_too_large", [e.path]);
    }
    return { baseSha: input.baseSha, headSha, commits, filesChanged: files.length, additions, deletions, files };
  } catch (error) {
    if (error instanceof DiffCheckError) throw error;
    throw new DiffCheckError("diff_failed");
  }
}
