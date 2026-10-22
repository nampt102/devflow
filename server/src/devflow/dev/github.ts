import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GITHUB_REPO } from "../systems/service.js";
import { authHeaderArgs, gitRunEnv } from "../systems/workspace.js";

const run = promisify(execFile);

// The little of GitHub the Dev stage needs (openspec/changes/add-dev-stage, design D3): is the default branch
// protected, push one branch with the write token, and open, update or close a DRAFT pull request. Plain `fetch`, no
// library. The token is sent only in the Authorization header of requests to api.github.com and in the header of one
// git process; errors keep the HTTP status and never the token, the URL or GitHub's text.

export type GithubFailureKind = "github_auth" | "github_forbidden" | "github_rejected" | "github_error" | "push_rejected" | "push_failed";

export class GithubError extends Error {
  constructor(readonly kind: GithubFailureKind, readonly status?: number) {
    super(`github ${kind}${status ? ` ${status}` : ""}`);
    this.name = "GithubError";
  }
}

const API = "https://api.github.com";
const DEV_REF = /^devflow\/[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;

export const parseRepo = (repoUrl: string): { owner: string; repo: string } => {
  if (!GITHUB_REPO.test(repoUrl)) throw new GithubError("github_rejected");
  const [owner, repo] = repoUrl.replace("https://github.com/", "").split("/");
  return { owner: owner!, repo: repo! };
};

export type PullRequest = { number: number; url: string; draft: boolean };
type FetchFn = typeof fetch;

export function githubClient(token: string, fetchFn: FetchFn = fetch) {
  async function call<T>(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200, 201]): Promise<T> {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devflow",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new GithubError("github_error");
    });
    if (!okStatuses.includes(res.status)) {
      throw new GithubError(res.status === 401 ? "github_auth" : res.status === 403 || res.status === 404 ? "github_forbidden" : res.status === 422 ? "github_rejected" : "github_error", res.status);
    }
    return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  }
  const pr = (j: { number: number; html_url: string; draft?: boolean }): PullRequest => ({ number: j.number, url: j.html_url, draft: j.draft === true });
  const repoPath = (repoUrl: string) => {
    const { owner, repo } = parseRepo(repoUrl);
    return { owner, path: `/repos/${owner}/${repo}` };
  };

  return {
    /** The token can push to the repository (GitHub reports the permissions of the token's user on it). */
    async canPush(repoUrl: string): Promise<boolean> {
      const j = await call<{ permissions?: { push?: boolean } }>("GET", repoPath(repoUrl).path);
      return j?.permissions?.push === true;
    },

    /**
     * Whether GitHub protects the branch. Only the flag is read: a rule set or a classic rule both set it, and the
     * rule's details need admin rights the write token does not have.
     */
    async isBranchProtected(repoUrl: string, branch: string): Promise<boolean> {
      const j = await call<{ protected?: boolean }>("GET", `${repoPath(repoUrl).path}/branches/${encodeURIComponent(branch)}`);
      return j?.protected === true;
    },

    /** The open pull request from `branch`, if any. */
    async findOpenPr(repoUrl: string, branch: string): Promise<PullRequest | null> {
      const { owner, path } = repoPath(repoUrl);
      const list = await call<{ number: number; html_url: string; draft?: boolean }[]>("GET", `${path}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      return list?.[0] ? pr(list[0]) : null;
    },

    async createDraftPr(repoUrl: string, input: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
      return pr(await call("POST", `${repoPath(repoUrl).path}/pulls`, { ...input, draft: true, maintainer_can_modify: false }));
    },

    async updatePr(repoUrl: string, number: number, input: { title?: string; body?: string }): Promise<PullRequest> {
      return pr(await call("PATCH", `${repoPath(repoUrl).path}/pulls/${number}`, input));
    },

    async comment(repoUrl: string, number: number, body: string): Promise<void> {
      await call("POST", `${repoPath(repoUrl).path}/issues/${number}/comments`, { body });
    },

    /** Closes the pull request; the branch stays. */
    async closePr(repoUrl: string, number: number): Promise<void> {
      await call("PATCH", `${repoPath(repoUrl).path}/pulls/${number}`, { state: "closed" });
    },

    /** Best effort: a missing label is created by GitHub, and a failure here must not undo the pull request. */
    async label(repoUrl: string, number: number, labels: string[]): Promise<void> {
      await call("POST", `${repoPath(repoUrl).path}/issues/${number}/labels`, { labels }).catch(() => undefined);
    },
  };
}
export type GithubClient = ReturnType<typeof githubClient>;

export type PushInput = {
  repoDir: string;
  repoUrl: string;
  /** devflow/<request key>: the only kind of branch DevFlow pushes to */
  branch: string;
  token: string;
  gitBin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

/**
 * Pushes HEAD to `refs/heads/<branch>` by URL, with the token in a header for this one git process. Never a force push,
 * never a hook, never any ref but `devflow/*`: GitHub would reject a rewrite and DevFlow never asks for one.
 */
export async function pushBranch(input: PushInput): Promise<void> {
  if (!DEV_REF.test(input.branch)) throw new GithubError("push_rejected");
  parseRepo(input.repoUrl);
  const args = [
    "-C", input.repoDir,
    "-c", "core.hooksPath=/dev/null",
    ...authHeaderArgs(input.token),
    "push", "--porcelain", "--no-verify", "--", input.repoUrl, `HEAD:refs/heads/${input.branch}`,
  ];
  try {
    await run(input.gitBin ?? "git", args, { env: gitRunEnv(input.env), timeout: input.timeoutMs ?? 300_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    // git echoes the URL and sometimes the header; keep only the kind of failure
    const rejected = /\[rejected\]|\[remote rejected\]|non-fast-forward|protected branch/i.test(String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? ""));
    throw new GithubError(rejected ? "push_rejected" : "push_failed");
  }
}
