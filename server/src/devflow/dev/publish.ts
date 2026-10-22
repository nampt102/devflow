import { checkDiff, DiffCheckError, type DiffFailureKind, type DiffSummary } from "./diff-check.js";
import { GithubError, githubClient, pushBranch, type GithubClient, type GithubFailureKind } from "./github.js";
import type { DevOutput } from "./schema.js";

// From the commits the Dev agent made to a draft pull request (openspec/changes/add-dev-stage, design D3). Nothing is
// pushed unless the diff passes DevFlow's checks and the default branch is protected (or the project owner accepted
// that it is not). DevFlow never merges and never pushes to anything but `devflow/*`.

export type PublishFailureKind = DiffFailureKind | GithubFailureKind | "repo_unprotected" | "write_token_cannot_push";

/** Why nothing (more) was published. `paths` are file names to show the reviewer; they come from the repository. */
export class DevPublishError extends Error {
  constructor(readonly kind: PublishFailureKind, readonly paths: readonly string[] = []) {
    super(`publish ${kind}`);
    this.name = "DevPublishError";
  }
}

export type PublishSystem = { key: string; repoUrl: string; defaultBranch: string; allowUnprotected: boolean; forbiddenPaths: readonly string[] };

export type PublishInput = {
  system: PublishSystem;
  repoDir: string;
  branch: string;
  /** the commit this run started from */
  baseSha: string;
  writeToken: string;
  caseKey: string;
  title: string;
  report: Pick<DevOutput, "summary" | "tasks" | "checks" | "risks" | "openQuestions">;
  /** where the reviewer finds the request in DevFlow, when the instance knows its address */
  caseUrl?: string | null;
  maxLines?: number;
};

export type PublishedRepo = {
  system: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  prUrl: string;
  prNumber: number;
  /** the pull request was opened by this run (false: an earlier run's pull request was updated) */
  newPr: boolean;
  /** the default branch is not protected and the project owner accepted that */
  unprotectedWarning: boolean;
};

export type PublishDeps = {
  github?: (token: string) => GithubClient;
  push?: typeof pushBranch;
  check?: (input: Parameters<typeof checkDiff>[0]) => Promise<DiffSummary | null>;
  /** replaceable in tests (a local repository stands in for GitHub) */
  gitEnv?: Record<string, string>;
};

const STATUS_LABEL = { done: "xong", partial: "một phần", skipped: "bỏ qua" } as const;
const BODY_CAP = 60_000;

/** Agent and requester words go into a public-facing text: no @mentions that would ping people, no line breaks in titles. */
const defang = (text: string) => text.replace(/(^|[^\w`@])@(?=[A-Za-z0-9])/g, "$1@​");
const oneLine = (text: string, max: number) => defang(text.replace(/\s+/g, " ").trim()).slice(0, max);

export const prTitle = (caseKey: string, title: string) => `[${caseKey}] ${oneLine(title, 180)}`;

export function prBody(input: Pick<PublishInput, "caseKey" | "caseUrl" | "report"> & { summary: DiffSummary; unprotectedWarning: boolean; baseBranch: string }): string {
  const r = input.report;
  const list = (items: readonly string[]) => items.map((i) => `- ${oneLine(i, 400)}`).join("\n");
  const parts = [
    `> Pull request nháp do agent Dev của DevFlow tạo cho yêu cầu **${input.caseKey}**. Người duyệt phải xem code trước khi merge; DevFlow không bao giờ merge.${input.caseUrl ? ` [Mở yêu cầu](${input.caseUrl})` : ""}`,
    input.unprotectedWarning ? `> ⚠️ Nhánh \`${input.baseBranch}\` của repo này **không được bảo vệ** (chủ dự án đã cho phép ngoại lệ). Chỉ merge sau khi có người duyệt.` : null,
    `**Tóm tắt**\n${defang(r.summary)}`,
    `**Thay đổi:** ${input.summary.filesChanged} file, +${input.summary.additions} −${input.summary.deletions}, ${input.summary.commits} commit`,
    `**Task**\n${r.tasks.map((t) => `- ${t.id} (${STATUS_LABEL[t.status]}): ${oneLine(t.notes, 500)}`).join("\n")}`,
    r.checks.length
      ? `**Kiểm tra**\n${r.checks.map((c) => `- ${c.passed ? "✅" : "❌"} \`${c.command.replace(/`/g, "'")}\``).join("\n")}`
      : "**Kiểm tra:** agent không chạy lệnh kiểm tra nào.",
    r.risks.length ? `**Rủi ro**\n${list(r.risks)}` : null,
    r.openQuestions.length ? `**Câu hỏi mở**\n${list(r.openQuestions)}` : null,
  ];
  return parts.filter(Boolean).join("\n\n").slice(0, BODY_CAP);
}

/**
 * Checks the agent's commits, then pushes the branch and opens (or updates) the draft pull request. Returns null when the
 * agent made no commit. Throws DevPublishError before anything is pushed when a check fails.
 */
export async function publishRepo(input: PublishInput, deps: PublishDeps = {}): Promise<PublishedRepo | null> {
  const check = deps.check ?? checkDiff;
  const push = deps.push ?? pushBranch;
  let summary: DiffSummary | null;
  try {
    summary = await check({
      repoDir: input.repoDir,
      baseSha: input.baseSha,
      branch: input.branch,
      extraForbiddenPaths: input.system.forbiddenPaths,
      maxLines: input.maxLines,
    });
  } catch (error) {
    if (error instanceof DiffCheckError) throw new DevPublishError(error.kind, error.paths);
    throw error;
  }
  if (!summary) return null;

  const github = (deps.github ?? githubClient)(input.writeToken);
  try {
    if (!(await github.canPush(input.system.repoUrl))) throw new DevPublishError("write_token_cannot_push");
    const protectedBranch = await github.isBranchProtected(input.system.repoUrl, input.system.defaultBranch);
    if (!protectedBranch && !input.system.allowUnprotected) throw new DevPublishError("repo_unprotected");
    const unprotectedWarning = !protectedBranch;

    await push({ repoDir: input.repoDir, repoUrl: input.system.repoUrl, branch: input.branch, token: input.writeToken, env: deps.gitEnv });

    const title = prTitle(input.caseKey, input.title);
    const body = prBody({ caseKey: input.caseKey, caseUrl: input.caseUrl, report: input.report, summary, unprotectedWarning, baseBranch: input.system.defaultBranch });
    const existing = await github.findOpenPr(input.system.repoUrl, input.branch);
    let pr;
    if (existing) {
      pr = await github.updatePr(input.system.repoUrl, existing.number, { title, body });
      await github.comment(input.system.repoUrl, existing.number, `Lượt chạy mới của agent Dev (${summary.commits} commit mới trên nhánh):\n\n${defang(input.report.summary)}`);
    } else {
      pr = await github.createDraftPr(input.system.repoUrl, { title, body, head: input.branch, base: input.system.defaultBranch });
      await github.label(input.system.repoUrl, pr.number, ["devflow"]);
    }
    return {
      system: input.system.key,
      branch: input.branch,
      baseBranch: input.system.defaultBranch,
      baseSha: summary.baseSha,
      headSha: summary.headSha,
      commits: summary.commits,
      filesChanged: summary.filesChanged,
      additions: summary.additions,
      deletions: summary.deletions,
      prUrl: pr.url,
      prNumber: pr.number,
      newPr: !existing,
      unprotectedWarning,
    };
  } catch (error) {
    if (error instanceof DevPublishError) throw error;
    if (error instanceof GithubError) throw new DevPublishError(error.kind);
    throw error;
  }
}
