import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drSystems, type Db } from "@paperclipai/db";
import { cloneSystem, gitRunEnv } from "../systems/workspace.js";
import { StageFailure, type StageFailureKind } from "../agent-stage/failure.js";
import { AgentOutputError } from "../agent-stage/output.js";
import { caps, stageService, type StageServiceDeps } from "../agent-stage/run-loop.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { loadApproved } from "../agent-stage/approved.js";
import { BA_STAGE } from "../ba/ba-service.js";
import { DEV_STAGE } from "../dev/dev-service.js";
import { PLAN_STAGE } from "../plan/plan-service.js";
import { devBranchName, devWorkspace, REPOS_DIR, type prepareDevRepo } from "../dev/workspace.js";
import { newBoundary } from "../prompts/ba.v1.js";
import { PROMPT_HASH, PROMPT_VERSION, buildRequestFile } from "../prompts/qa.v1.js";
import { sanitizeUntrusted } from "../triage/triage-service.js";
import { qaAgentProblem } from "./agent.js";
import { devReportText, numberedCriteria, testPlanItems } from "./input.js";
import { mergeQaOutputs, parseQaOutput, qaCommentMarkdown, recommend, type QaOutput, type QaWarning } from "./schema.js";

const run = promisify(execFile);

// QA for one request (openspec/changes/add-qa-stage, design D1 to D4) on the shared stage run loop: the agent checks the branch
// of the pull request on the runner, DevFlow reads the report, adds its own recommendation and warnings, and the request
// goes to QA sign-off. Nothing is pushed in this stage: whatever the agent changed or committed is thrown away with the
// workspace. The input is what reviewers approved (BA spec, plan, Dev work), not agents' drafts.

export const QA_STAGE = "qa";
export const QA_SIGNOFF_STAGE = "qa_signoff";
const MAX_ATTEMPTS = 2; // one more run when the agent's JSON is rejected

const asStageFailure = (kind: string): StageFailure => new StageFailure(kind as StageFailureKind);

export type QaServiceDeps = Omit<StageServiceDeps, "clone"> & {
  /** replaceable in tests */
  prepare?: typeof prepareDevRepo;
  gitEnv?: Record<string, string>;
};

type Row = Record<string, any>;
export type QaRepoResult = {
  system: string;
  branch: string;
  /** the head the Dev work was approved at, and the head this run checked */
  approvedSha: string | null;
  testedSha: string;
  prUrl: string | null;
  prNumber: number | null;
  warnings: QaWarning[];
};

export function qaService(db: Db, deps: QaServiceDeps) {
  const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const workspace = devWorkspace({ root, role: "qa", resolveToken: deps.resolveToken, prepare: deps.prepare, env: deps.gitEnv });
  // the parts shared with the other agent stages: pending list, the ledger, the daily cap, proposal and transition
  const shared = stageService(
    db,
    {
      role: "qa",
      stageKey: QA_STAGE,
      reviewStageKey: QA_SIGNOFF_STAGE,
      actorId: "devflow-qa",
      prompt: { version: PROMPT_VERSION, hash: PROMPT_HASH },
      artifact: "report",
      proposedReason: "qa_proposed",
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

  async function headOf(repoDir: string): Promise<string> {
    const { stdout } = await run("git", ["-C", repoDir, "rev-parse", "HEAD"], { env: gitRunEnv(deps.gitEnv), timeout: 30_000 });
    return stdout.trim();
  }

  /** "proposed", or "stale" when the case moved or already has a proposal. */
  async function runCase(companyId: string, caseId: string): Promise<"proposed" | "stale"> {
    const row = await shared.loadCase(companyId, caseId);
    if (!row || row.stageKey !== QA_STAGE) return "stale";

    const { agent, problem } = await qaAgentProblem(db, companyId, root);
    if (!agent) throw new StageFailure("no_agent");
    if (problem) throw asStageFailure(problem);

    const spec = await loadApproved(db, companyId, caseId, BA_STAGE);
    const plan = await loadApproved(db, companyId, caseId, PLAN_STAGE);
    const devWork = await loadApproved(db, companyId, caseId, DEV_STAGE);
    const criteria = spec ? numberedCriteria(spec) : [];
    if (!spec || !plan || criteria.length === 0) throw new StageFailure("no_approved_spec");
    const criterionIds = criteria.map((c) => c.id);

    // the systems of the pull requests the code reviewer approved, that are still in the catalog
    const approvedRepos: Row[] = (Array.isArray(devWork?.repos) ? devWork.repos : []).filter((r: Row) => typeof r?.prUrl === "string" && typeof r?.system === "string");
    const systems = approvedRepos.length
      ? await db
          .select({ key: drSystems.key, repoUrl: drSystems.repoUrl, defaultBranch: drSystems.defaultBranch, tokenSecretId: drSystems.tokenSecretId, writeTokenSecretId: drSystems.writeTokenSecretId, testCommand: drSystems.testCommand })
          .from(drSystems)
          .where(and(eq(drSystems.companyId, companyId), eq(drSystems.active, true), inArray(drSystems.key, approvedRepos.map((r) => r.system as string))))
          .orderBy(asc(drSystems.key))
      : [];
    if (!devWork || systems.length === 0) throw new StageFailure("no_qa_target");

    const caseTitle = sanitizeUntrusted(row.title, caps.title);
    const outputs: QaOutput[] = [];
    const repos: QaRepoResult[] = [];
    const warnings = new Set<QaWarning>();
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let model: string | null = null;
    let runId: string | null = null;

    // ponytail: systems run one after the other; a later failure repeats the earlier ones on retry
    for (const system of systems) {
      const key = system.key;
      const approvedRepo = approvedRepos.find((r) => r.system === key)!;
      let output: QaOutput | null = null;
      let correction: string | null = null;
      const repoWarnings: QaWarning[] = [];
      let testedSha = "";
      try {
        await workspace.reset();
        // QA only reads: the read token clones, and a repository with only a write token is cloned with that
        const [prepared] = await workspace.prepareAll(companyId, row.caseKey, [
          { key, repoUrl: system.repoUrl, defaultBranch: system.defaultBranch, tokenSecretId: system.tokenSecretId ?? system.writeTokenSecretId },
        ]);
        testedSha = prepared!.sha;
        if (typeof approvedRepo.headSha === "string" && approvedRepo.headSha !== testedSha) repoWarnings.push("branch_moved");
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !output; attempt++) {
          const requestFile =
            buildRequestFile({
              boundary: newBoundary(),
              caseKey: row.caseKey,
              title: caseTitle,
              description: sanitizeUntrusted(row.description, caps.description),
              businessImpact: row.businessImpact ? sanitizeUntrusted(row.businessImpact, caps.impact) : null,
              triage: row.classification && row.priority && row.difficulty ? { classification: row.classification, priority: row.priority, difficulty: row.difficulty } : null,
              systems: [{ key, branch: prepared!.branch, sha: testedSha, testCommand: system.testCommand, prUrl: typeof approvedRepo.prUrl === "string" ? approvedRepo.prUrl : null }],
              criteria,
              testPlan: testPlanItems(plan),
              devReport: devReportText(devWork),
            }) +
            (correction
              ? `\n## Correction (DevFlow's own text)\nYour previous answer was rejected: ${correction}. Write the report again and return only one valid JSON object that follows the schema.\n`
              : "");
          await workspace.writeRequest(requestFile);
          const result = await deps.runner.run({ companyId, agentId: agent.id, caseId, reason: `devflow_qa:${row.caseKey}` });
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
            output = parseQaOutput(result.text, criterionIds, [key]);
          } catch (err) {
            if (!(err instanceof AgentOutputError)) throw err;
            if (attempt === MAX_ATTEMPTS) throw new StageFailure("invalid_output");
            correction = err.message;
          }
        }
        if (!output) throw new StageFailure("invalid_output");
        // the agent may not commit; if it did, the commit goes nowhere, and the reviewer is told
        const after = await headOf(path.join(workspace.dir, REPOS_DIR, key)).catch(() => testedSha);
        if (after !== testedSha) repoWarnings.push("qa_modified_branch");
      } finally {
        await workspace.clear();
      }
      for (const w of repoWarnings) warnings.add(w);
      outputs.push(output);
      repos.push({
        system: key,
        branch: devBranchName(row.caseKey),
        approvedSha: typeof approvedRepo.headSha === "string" ? approvedRepo.headSha : null,
        testedSha,
        prUrl: typeof approvedRepo.prUrl === "string" ? approvedRepo.prUrl : null,
        prNumber: typeof approvedRepo.prNumber === "number" ? approvedRepo.prNumber : null,
        warnings: repoWarnings,
      });
    }

    const merged = mergeQaOutputs(outputs);
    const warningList = [...warnings];
    const recommendation = recommend(merged, warningList);
    const criteriaText = Object.fromEntries(criteria.map((c) => [c.id, c.text]));
    const data = { ...merged, repos, warnings: warningList, recommendation, criteriaText, model, runId, costUsd, inputTokens, outputTokens };
    return shared.submit({
      companyId,
      caseId,
      agentId: agent.id,
      version: row.version,
      data,
      commentText: qaCommentMarkdown(merged, recommendation, criteriaText),
      runId,
      keys: systems.map((s) => s.key),
      costUsd,
      inputTokens,
      outputTokens,
    });
  }

  return { findPending: shared.findPending, runCase, overBudgetCompanies: shared.overBudgetCompanies, recordBudgetPause: shared.recordBudgetPause, recordFailure: shared.recordFailure };
}

export type QaService = ReturnType<typeof qaService>;
