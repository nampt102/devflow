import path from "node:path";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { assets, drAgentOutputs, drAttachments, drRequestSystems, drSystems, type Db } from "@paperclipai/db";
import { cloneSystem } from "../systems/workspace.js";
import { StageFailure, type StageFailureKind } from "../agent-stage/failure.js";
import { AgentOutputError } from "../agent-stage/output.js";
import { caps, stageService, type StageServiceDeps } from "../agent-stage/run-loop.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { BA_STAGE } from "../ba/ba-service.js";
import { PLAN_STAGE, approvedSpecText } from "../plan/plan-service.js";
import { planOutputSchema, type PlanOutput } from "../plan/schema.js";
import { PROMPT_HASH, PROMPT_VERSION, buildRequestFile } from "../prompts/dev.v1.js";
import { newBoundary } from "../prompts/ba.v1.js";
import { sanitizeUntrusted } from "../triage/triage-service.js";
import { devAgentProblem } from "./agent.js";
import { approvedPlanText, devTaskIds } from "./input.js";
import { loadApproved } from "../agent-stage/approved.js";
import { qaFindingsText } from "../qa/input.js";
import { githubClient } from "./github.js";
import { DevPublishError, publishRepo, type PublishDeps, type PublishedRepo } from "./publish.js";
import { devCommentMarkdown, parseDevOutput, type DevOutput, type DevRepoResult } from "./schema.js";
import { devWorkspace, REPOS_DIR } from "./workspace.js";

// Dev for one request (openspec/changes/add-dev-stage, design D3 to D6) on the shared stage run loop: the agent works on
// the runner, DevFlow checks and publishes what it committed, and the request goes to code review with the draft pull
// request. The input is what reviewers approved (`data.approved` of the BA spec and the Tech Plan), not agents' drafts.

export const DEV_STAGE = "dev";
export const CODE_REVIEW_STAGE = "code_review";
const MAX_ATTEMPTS = 2; // one more run when the agent's JSON is rejected

/** The diff checks that end in a proposal the reviewer can read (nothing is pushed); everything else is a failure to retry. */
const BLOCKED_KINDS = new Set(["wrong_branch", "history_rewritten", "forbidden_paths", "diff_too_large", "binary_too_large", "submodule_change"]);

const asStageFailure = (kind: string): StageFailure => new StageFailure(kind as StageFailureKind);

/**
 * GitHub refusals that show up only after the agent has run (the same kinds are setup problems when found before):
 * they cost a run, so they are retried with backoff and given up on, not calmly forever.
 */
const DENIED_AFTER_RUN = new Set(["github_auth", "github_forbidden", "write_token_cannot_push", "repo_unprotected"]);

export type DevServiceDeps = Omit<StageServiceDeps, "clone"> & {
  /** replaceable in tests */
  publish?: typeof publishRepo;
  publishDeps?: PublishDeps;
  gitEnv?: Record<string, string>;
  prepare?: Parameters<typeof devWorkspace>[0]["prepare"];
  maxDiffLines?: number;
  /** where a reviewer finds the request in DevFlow, for the pull request text */
  caseUrl?: (caseId: string) => string | null;
};

type Row = Record<string, any>;

export function devService(db: Db, deps: DevServiceDeps) {
  const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const publish = deps.publish ?? publishRepo;
  const workspace = devWorkspace({ root, resolveToken: deps.resolveToken, prepare: deps.prepare, env: deps.gitEnv });
  // the parts shared with BA and Planner: pending list, feedback, the ledger, the daily cap, proposal and transition
  const shared = stageService(
    db,
    {
      role: "dev",
      stageKey: DEV_STAGE,
      reviewStageKey: CODE_REVIEW_STAGE,
      actorId: "devflow-dev",
      prompt: { version: PROMPT_VERSION, hash: PROMPT_HASH },
      artifact: "report",
      proposedReason: "dev_proposed",
      unsafeReason: () => null,
      loadContext: async () => null,
      buildRequest: () => "",
      parse: () => {
        throw new AgentOutputError("not used");
      },
      comment: () => "",
    },
    { ...deps, clone: cloneSystem },
  );

  const approved = (companyId: string, caseId: string, stageKey: string): Promise<Row | null> => loadApproved(db, companyId, caseId, stageKey);

  /** The systems of the request that may be coded: Dev switched on, with their write token. */
  async function devSystems(companyId: string, caseId: string) {
    return db
      .select({
        key: drSystems.key,
        repoUrl: drSystems.repoUrl,
        defaultBranch: drSystems.defaultBranch,
        tokenSecretId: drSystems.tokenSecretId,
        writeTokenSecretId: drSystems.writeTokenSecretId,
        testCommand: drSystems.testCommand,
        forbiddenPaths: drSystems.forbiddenPaths,
        allowUnprotected: drSystems.allowUnprotected,
      })
      .from(drRequestSystems)
      .innerJoin(drSystems, and(eq(drSystems.id, drRequestSystems.systemId), eq(drSystems.companyId, drRequestSystems.companyId)))
      .where(and(eq(drRequestSystems.caseId, caseId), eq(drRequestSystems.companyId, companyId), eq(drSystems.active, true), eq(drSystems.devEnabled, true)))
      .orderBy(asc(drSystems.key));
  }

  /**
   * After QA sign-off sent the work back, the reviewer's reason is joined by what QA found. Only when QA decided after the
   * Dev proposal that was superseded: a code reviewer sending the work back later must not be told about an old QA round.
   */
  async function withQaFindings(companyId: string, caseId: string, feedback: { previousSummary: string; text: string } | null) {
    if (!feedback) return feedback;
    const [prev] = await db
      .select({ createdAt: drAgentOutputs.createdAt })
      .from(drAgentOutputs)
      .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, DEV_STAGE), eq(drAgentOutputs.status, "superseded")))
      .orderBy(desc(drAgentOutputs.createdAt))
      .limit(1);
    const [qa] = await db
      .select({ data: drAgentOutputs.data, decidedAt: drAgentOutputs.decidedAt })
      .from(drAgentOutputs)
      .where(and(eq(drAgentOutputs.companyId, companyId), eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, "qa"), eq(drAgentOutputs.status, "superseded"), isNotNull(drAgentOutputs.decidedAt)))
      .orderBy(desc(drAgentOutputs.decidedAt))
      .limit(1);
    if (!prev || !qa?.decidedAt || qa.decidedAt < prev.createdAt) return feedback;
    const findings = qaFindingsText(qa.data as Row);
    return findings ? { ...feedback, text: `${feedback.text} ${findings}`.slice(0, 3000) } : feedback;
  }

  /** The write token can push and read pull requests, and the default branch is protected (or the owner allowed otherwise). */
  async function preflightGithub(system: { repoUrl: string; defaultBranch: string; allowUnprotected: boolean }, token: string) {
    const github = (deps.publishDeps?.github ?? githubClient)(token);
    try {
      if (!(await github.canPush(system.repoUrl))) throw new StageFailure("write_token_cannot_push");
      // listing pull requests needs the same permission as opening one (the first real run found a token without it)
      await github.findOpenPr(system.repoUrl, "devflow/preflight");
      if (!(await github.isBranchProtected(system.repoUrl, system.defaultBranch)) && !system.allowUnprotected) throw new StageFailure("repo_unprotected");
    } catch (err) {
      if (err instanceof StageFailure) throw err;
      throw asStageFailure((err as { kind?: string }).kind ?? "github_error");
    }
  }

  /** "proposed", or "stale" when the case moved or already has a proposal. */
  async function runCase(companyId: string, caseId: string): Promise<"proposed" | "stale"> {
    const row = await shared.loadCase(companyId, caseId);
    if (!row || row.stageKey !== DEV_STAGE) return "stale";

    const { agent, problem } = await devAgentProblem(db, companyId, root);
    if (!agent) throw new StageFailure("no_agent");
    if (problem) throw asStageFailure(problem);

    const spec = await approved(companyId, caseId, BA_STAGE);
    const planRaw = await approved(companyId, caseId, PLAN_STAGE);
    const parsedPlan = planOutputSchema.safeParse(planRaw);
    if (!spec || !parsedPlan.success) throw new StageFailure("no_approved_plan");
    const plan: PlanOutput = parsedPlan.data;

    const targets = (await devSystems(companyId, caseId)).filter((s) => devTaskIds(plan, [s.key]).length > 0);
    if (targets.length === 0) throw new StageFailure("no_dev_system");

    const files = await db
      .select({ name: assets.originalFilename })
      .from(drAttachments)
      .innerJoin(assets, eq(assets.id, drAttachments.assetId))
      .where(and(eq(drAttachments.caseId, caseId), eq(drAttachments.companyId, companyId)))
      .limit(caps.files);
    const attachmentNames = files.map((f) => sanitizeUntrusted(f.name ?? "(no name)", caps.fileName));
    const feedback = await withQaFindings(companyId, caseId, await shared.loadFeedback(companyId, caseId));
    const specText = approvedSpecText(spec);
    const caseTitle = sanitizeUntrusted(row.title, caps.title);

    const outputs: DevOutput[] = [];
    const repos: DevRepoResult[] = [];
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let model: string | null = null;
    let runId: string | null = null;

    // ponytail: systems run one after the other and each is published right after its run; when a later one fails,
    // the retry runs the earlier ones again on their (already pushed) branches. Track per-system progress if it matters.
    for (const system of targets) {
      const key = system.key;
      const taskIds = devTaskIds(plan, [key]);
      let output: DevOutput | null = null;
      let correction: string | null = null;
      let repo: DevRepoResult | null = null;
      // before anything is spent: a system whose write token is gone cannot be published
      const writeToken = system.writeTokenSecretId ? await deps.resolveToken(companyId, system.writeTokenSecretId).catch(() => null) : null;
      if (!writeToken) throw new StageFailure("system_missing_token");
      // ... and before the agent runs: a token without the right permissions, or a default branch that may not be
      // pushed to, would otherwise be found only after a paid run (the first real smoke run lost its work this way)
      await preflightGithub(system, writeToken);
      try {
        await workspace.reset();
        const [prepared] = await workspace.prepareAll(companyId, row.caseKey, [
          // the read token clones; a repository with only a write token is cloned with that
          { key, repoUrl: system.repoUrl, defaultBranch: system.defaultBranch, tokenSecretId: system.tokenSecretId ?? system.writeTokenSecretId },
        ]);
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !output; attempt++) {
          const requestFile =
            buildRequestFile({
              boundary: newBoundary(),
              caseKey: row.caseKey,
              title: caseTitle,
              description: sanitizeUntrusted(row.description, caps.description),
              businessImpact: row.businessImpact ? sanitizeUntrusted(row.businessImpact, caps.impact) : null,
              attachmentNames,
              triage: row.classification && row.priority && row.difficulty ? { classification: row.classification, priority: row.priority, difficulty: row.difficulty } : null,
              systems: [{ key, branch: prepared!.branch, baseBranch: prepared!.baseBranch, sha: prepared!.sha, testCommand: system.testCommand, forbiddenPaths: system.forbiddenPaths }],
              approvedSpec: specText,
              approvedPlan: approvedPlanText(plan, [key]),
              feedback,
            }) +
            (correction
              ? `\n## Correction (DevFlow's own text)\nYour previous answer was rejected: ${correction}. Write the report again and return only one valid JSON object that follows the schema.\n`
              : "");
          await workspace.writeRequest(requestFile);
          const result = await deps.runner.run({ companyId, agentId: agent.id, caseId, reason: `devflow_dev:${row.caseKey}` });
          costUsd += result.costUsd;
          inputTokens += result.inputTokens;
          outputTokens += result.outputTokens;
          model = result.model ?? model;
          runId = result.runId ?? runId;
          if (!result.ok || !result.text) {
            const kind: StageFailureKind =
              result.subtype === "error_max_budget_usd" ? "budget_exhausted" : result.errorCode === "run_timeout" ? "run_timeout" : result.errorCode === "wake_skipped" ? "wake_skipped" : "run_failed";
            await shared.recordRun(companyId, caseId, agent.id, result, kind);
            throw new StageFailure(kind);
          }
          await shared.recordRun(companyId, caseId, agent.id, result, null);
          try {
            output = parseDevOutput(result.text, taskIds, [key]);
          } catch (err) {
            if (!(err instanceof AgentOutputError)) throw err;
            if (attempt === MAX_ATTEMPTS) throw new StageFailure("invalid_output");
            correction = err.message;
          }
        }
        if (!output) throw new StageFailure("invalid_output");

        try {
          const published = await publish(
            {
              system: { key, repoUrl: system.repoUrl, defaultBranch: system.defaultBranch, allowUnprotected: system.allowUnprotected, forbiddenPaths: system.forbiddenPaths },
              repoDir: path.join(workspace.dir, REPOS_DIR, key),
              branch: prepared!.branch,
              baseSha: prepared!.sha,
              writeToken,
              caseKey: row.caseKey,
              title: caseTitle,
              report: output,
              caseUrl: deps.caseUrl?.(caseId) ?? null,
              maxLines: deps.maxDiffLines,
            },
            { ...deps.publishDeps, gitEnv: deps.gitEnv },
          );
          repo = published ?? { system: key, branch: prepared!.branch, baseBranch: prepared!.baseBranch, baseSha: prepared!.sha, noChanges: true };
        } catch (err) {
          if (!(err instanceof DevPublishError)) throw err;
          if (!BLOCKED_KINDS.has(err.kind)) throw asStageFailure(err.kind === "diff_failed" ? "workspace_failed" : DENIED_AFTER_RUN.has(err.kind) ? "publish_denied" : err.kind);
          // nothing is pushed; the reviewer reads why
          repo = { system: key, branch: prepared!.branch, baseBranch: prepared!.baseBranch, baseSha: prepared!.sha, blocked: { kind: err.kind, paths: err.paths.slice(0, 20) } };
        }
      } finally {
        await workspace.clear();
      }
      outputs.push(output);
      repos.push(repo);
    }

    const merged = mergeOutputs(outputs);
    const data = { ...merged, repos, model, runId, costUsd, inputTokens, outputTokens };
    return shared.submit({
      companyId,
      caseId,
      agentId: agent.id,
      version: row.version,
      data,
      commentText: devCommentMarkdown(merged, repos),
      runId,
      keys: targets.map((t) => t.key),
      costUsd,
      inputTokens,
      outputTokens,
    });
  }

  return { findPending: shared.findPending, runCase, overBudgetCompanies: shared.overBudgetCompanies, recordBudgetPause: shared.recordBudgetPause, recordFailure: shared.recordFailure };
}

const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;

/** One report out of the per-system ones: texts joined, lists joined, the least confident rating. */
export function mergeOutputs(outputs: readonly DevOutput[]): DevOutput {
  if (outputs.length === 1) return outputs[0]!;
  return {
    summary: outputs.map((o) => o.summary).join(" ").slice(0, 800),
    tasks: outputs.flatMap((o) => o.tasks).slice(0, 30),
    checks: outputs.flatMap((o) => o.checks).slice(0, 20),
    openQuestions: outputs.flatMap((o) => o.openQuestions).slice(0, 10),
    risks: outputs.flatMap((o) => o.risks).slice(0, 10),
    confidence: CONFIDENCE_ORDER[Math.min(...outputs.map((o) => CONFIDENCE_ORDER.indexOf(o.confidence)))]!,
  };
}

export type DevService = ReturnType<typeof devService>;
export type { PublishedRepo };
