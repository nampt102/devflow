import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, isNull, notExists, notInArray, sql } from "drizzle-orm";
import {
  assets,
  drAgentOutputs,
  drAttachments,
  drRequestSystems,
  drRequests,
  drSystems,
  heartbeatRuns,
  pipelineCases,
  pipelineStages,
  pipelines,
  type Db,
} from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, buildRequestFile, newBoundary, type RequestFileSystem } from "../prompts/ba.v1.js";
import { TRIAGE_PIPELINE_KEY, sanitizeUntrusted } from "../triage/triage-service.js";
import { baWorkspaceDir, DEFAULT_WORKSPACE_ROOT, findBaAgent, unsafeBaAgentReason } from "./agent.js";
import { baCommentMarkdown, BaOutputError, parseBaOutput, type BaOutput } from "./schema.js";
import type { BaRunner } from "./runner.js";
import type { cloneSystem } from "../systems/workspace.js";

// BA Spec for one request (openspec/changes/add-ba-spec-stage, design D1 to D5): prepare the workspace, run the agent
// through Paperclip, check what it said, store it as a proposal and send the request to BA review.

export type BaFailureKind =
  | "no_agent"
  | "agent_not_runnable"
  | "agent_wrong_adapter"
  | "agent_wrong_engine"
  | "agent_wrong_workspace"
  | "agent_no_instructions"
  | "agent_extra_capability"
  | "agent_tools_not_read_only"
  | "agent_instance_not_denied"
  | "agent_no_budget"
  | "agent_prompt_outdated"
  | "system_missing_token"
  | "clone_failed"
  | "clone_timeout"
  | "workspace_failed"
  | "run_failed"
  | "run_timeout"
  | "wake_skipped"
  | "budget_exhausted"
  | "invalid_output"
  | "transition_failed";

export class BaFailure extends Error {
  constructor(readonly kind: BaFailureKind) {
    super(`ba ${kind}`);
    this.name = "BaFailure";
  }
}

const MAX_ATTEMPTS = 2; // one more run when the agent's JSON is rejected
const caps = { title: 300, description: 8000, impact: 2000, fileName: 120, files: 10, feedback: 1000, summary: 300 };
export const BA_STAGE = "ba_spec";
export const BA_REVIEW_STAGE = "ba_review";

type PipelineTransitions = { transitionCase: (input: any) => Promise<unknown> };
type Clone = typeof cloneSystem;

export type BaServiceDeps = {
  pipelines: PipelineTransitions;
  runner: BaRunner;
  clone: Clone;
  /** reads the token of a system's secret; null when the secret is gone */
  resolveToken: (companyId: string, secretId: string) => Promise<string | null>;
  workspaceRoot?: string;
  maxUsdPerDay?: number;
};

export function baService(db: Db, deps: BaServiceDeps) {
  const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const workspace = baWorkspaceDir(root);

  async function loadCase(companyId: string, caseId: string) {
    const [row] = await db
      .select({
        version: pipelineCases.version,
        caseKey: pipelineCases.caseKey,
        title: pipelineCases.title,
        stageKey: pipelineStages.key,
        description: drRequests.description,
        businessImpact: drRequests.businessImpact,
        classification: drRequests.classification,
        priority: drRequests.priority,
        difficulty: drRequests.difficulty,
      })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
      .innerJoin(drRequests, and(eq(drRequests.caseId, pipelineCases.id), eq(drRequests.companyId, pipelineCases.companyId)))
      .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId)));
    return row ?? null;
  }

  /** Cases waiting in `ba_spec` with no live proposal (also re-picks cases sent back by request_changes). */
  async function findPending(limit: number, excludeCompanyIds: readonly string[] = []) {
    return db
      .select({ caseId: pipelineCases.id, companyId: pipelineCases.companyId })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
      .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
      .innerJoin(drRequests, and(eq(drRequests.caseId, pipelineCases.id), eq(drRequests.companyId, pipelineCases.companyId)))
      .where(
        and(
          eq(pipelines.key, TRIAGE_PIPELINE_KEY),
          excludeCompanyIds.length ? notInArray(pipelineCases.companyId, [...excludeCompanyIds]) : undefined,
          isNull(pipelines.archivedAt),
          eq(pipelineStages.key, BA_STAGE),
          isNull(pipelineCases.terminalKind),
          notExists(
            db
              .select({ one: sql`1` })
              .from(drAgentOutputs)
              .where(and(eq(drAgentOutputs.caseId, pipelineCases.id), eq(drAgentOutputs.stageKey, BA_STAGE), eq(drAgentOutputs.status, "proposed"))),
          ),
        ),
      )
      .orderBy(asc(pipelineCases.createdAt))
      .limit(limit);
  }

  async function assignedSystems(companyId: string, caseId: string) {
    return db
      .select({ id: drSystems.id, key: drSystems.key, repoUrl: drSystems.repoUrl, branch: drSystems.defaultBranch, docsPath: drSystems.docsPath, tokenSecretId: drSystems.tokenSecretId })
      .from(drRequestSystems)
      .innerJoin(drSystems, and(eq(drSystems.id, drRequestSystems.systemId), eq(drSystems.companyId, drRequestSystems.companyId)))
      .where(and(eq(drRequestSystems.caseId, caseId), eq(drRequestSystems.companyId, companyId), eq(drSystems.active, true)))
      .orderBy(asc(drSystems.key));
  }

  /** After request_changes: the reviewer's reason and the summary of the spec that was sent back. */
  async function loadFeedback(companyId: string, caseId: string): Promise<{ previousSummary: string; text: string } | null> {
    const [prev] = await db
      .select({ data: drAgentOutputs.data, createdAt: drAgentOutputs.createdAt })
      .from(drAgentOutputs)
      .where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, BA_STAGE), eq(drAgentOutputs.status, "superseded")))
      .orderBy(desc(drAgentOutputs.createdAt))
      .limit(1);
    if (!prev) return null;
    // only a decision made after that spec existed: an older request_changes belongs to Triage
    const [ev] = (await db.execute(sql`
      select payload->>'reason' as reason from pipeline_case_events
      where company_id = ${companyId} and case_id = ${caseId} and type = 'review_decided' and payload->>'decision' = 'request_changes'
        and created_at >= ${prev.createdAt.toISOString()}::timestamptz
      order by created_at desc, id desc limit 1`)) as unknown as Array<{ reason: string | null }>;
    if (!ev?.reason?.trim()) return null;
    const summary = typeof (prev.data as Record<string, unknown>).summary === "string" ? String((prev.data as Record<string, unknown>).summary) : "";
    return {
      previousSummary: sanitizeUntrusted(summary, caps.summary).replace(/\s+/g, " "),
      text: sanitizeUntrusted(ev.reason, caps.feedback).replace(/\s+/g, " "),
    };
  }

  /** The workspace is emptied before and after every run: only the request being worked on is ever on disk. */
  async function resetWorkspace() {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.mkdir(path.join(workspace, ".devflow"), { recursive: true });
    await fs.mkdir(path.join(workspace, "repos"), { recursive: true });
  }

  async function prepareRepos(companyId: string, systems: Awaited<ReturnType<typeof assignedSystems>>): Promise<RequestFileSystem[]> {
    const out: RequestFileSystem[] = [];
    for (const s of systems) {
      let token: string | null = null;
      if (s.tokenSecretId) {
        token = await deps.resolveToken(companyId, s.tokenSecretId).catch(() => null);
        if (!token) throw new BaFailure("system_missing_token");
      }
      try {
        const { sha } = await deps.clone({ repoUrl: s.repoUrl, branch: s.branch, dest: path.join(workspace, "repos", s.key), token });
        out.push({ key: s.key, docsPath: s.docsPath, sha });
      } catch (err) {
        throw new BaFailure((err as Error).message === "clone_timeout" ? "clone_timeout" : "clone_failed");
      }
    }
    return out;
  }

  async function recordRun(companyId: string, caseId: string, agentId: string, r: { runId: string | null; ok: boolean; costUsd: number; inputTokens: number; outputTokens: number }, kind: string | null) {
    // DevFlow's own ledger for the daily cap: Paperclip's accounting of a run can lag behind the run
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "devflow-ba",
      agentId,
      action: "agent.ba_run",
      entityType: "pipeline_case",
      entityId: caseId,
      details: { runId: r.runId, ok: r.ok, kind, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, promptVersion: PROMPT_VERSION },
    }).catch((e) => logger.warn({ err: e }, "devflow ba: run not logged"));
  }

  /** Returns "proposed", or "stale" when the case moved or already has a proposal (nothing written). */
  async function baCase(companyId: string, caseId: string): Promise<"proposed" | "stale"> {
    const row = await loadCase(companyId, caseId);
    if (!row || row.stageKey !== BA_STAGE) return "stale";

    const agent = await findBaAgent(db, companyId);
    if (!agent) throw new BaFailure("no_agent");
    const unsafe = unsafeBaAgentReason(agent, root);
    if (unsafe) throw new BaFailure(unsafe as BaFailureKind);

    const systems = await assignedSystems(companyId, caseId);
    const files = await db
      .select({ name: assets.originalFilename })
      .from(drAttachments)
      .innerJoin(assets, eq(assets.id, drAttachments.assetId))
      .where(and(eq(drAttachments.caseId, caseId), eq(drAttachments.companyId, companyId)))
      .limit(caps.files);
    const attachmentNames = files.map((f) => sanitizeUntrusted(f.name ?? "(no name)", caps.fileName));
    const feedback = await loadFeedback(companyId, caseId);
    const keys = systems.map((s) => s.key);

    let output: BaOutput | null = null;
    let repos: RequestFileSystem[] = [];
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let model: string | null = null;
    let runId: string | null = null;
    let correction: string | null = null;
    try {
      await resetWorkspace().catch(() => {
        throw new BaFailure("workspace_failed");
      });
      repos = await prepareRepos(companyId, systems);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !output; attempt++) {
        const requestFile =
          buildRequestFile({
            boundary: newBoundary(),
            caseKey: row.caseKey,
            title: sanitizeUntrusted(row.title, caps.title),
            description: sanitizeUntrusted(row.description, caps.description),
            businessImpact: row.businessImpact ? sanitizeUntrusted(row.businessImpact, caps.impact) : null,
            attachmentNames,
            triage: row.classification && row.priority && row.difficulty ? { classification: row.classification, priority: row.priority, difficulty: row.difficulty } : null,
            systems: repos,
            feedback,
          }) + (correction ? `\n## Correction (DevFlow's own text)\nYour previous answer was rejected: ${correction}. Write the spec again and return only one valid JSON object that follows the schema.\n` : "");
        await fs.writeFile(path.join(workspace, ".devflow", "request.md"), requestFile, "utf8").catch(() => {
          throw new BaFailure("workspace_failed");
        });
        const result = await deps.runner.run({ companyId, agentId: agent.id, caseId, reason: `devflow_ba:${row.caseKey}` });
        costUsd += result.costUsd;
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
        model = result.model ?? model;
        runId = result.runId ?? runId;
        if (!result.ok || !result.text) {
          const kind: BaFailureKind =
            result.subtype === "error_max_budget_usd" ? "budget_exhausted" : result.errorCode === "run_timeout" ? "run_timeout" : result.errorCode === "wake_skipped" ? "wake_skipped" : "run_failed";
          await recordRun(companyId, caseId, agent.id, result, kind);
          throw new BaFailure(kind);
        }
        await recordRun(companyId, caseId, agent.id, result, null);
        try {
          output = parseBaOutput(result.text, keys);
        } catch (err) {
          if (!(err instanceof BaOutputError)) throw err;
          if (attempt === MAX_ATTEMPTS) throw new BaFailure("invalid_output");
          correction = err.message;
        }
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!output) throw new BaFailure("invalid_output");

    const data = {
      ...output,
      repos: repos.map((r) => ({ system: r.key, sha: r.sha })),
      model,
      runId,
      costUsd,
      inputTokens,
      outputTokens,
    };
    const commentText = baCommentMarkdown(output);

    // link the proposal to its run when the run row exists (a missing row would break the foreign key)
    const [runRow] = runId ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)) : [];

    // First writer wins: the unique index allows one live proposal per stage.
    let outputId: string | null;
    try {
      outputId = await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select({ version: pipelineCases.version, stageKey: pipelineStages.key })
          .from(pipelineCases)
          .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
          .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId)))
          .for("update", { of: pipelineCases });
        if (!fresh || fresh.stageKey !== BA_STAGE || fresh.version !== row.version) return null;
        const [inserted] = await tx
          .insert(drAgentOutputs)
          .values({ companyId, caseId, stageKey: BA_STAGE, agentId: agent.id, runId: runRow?.id ?? null, promptRole: PROMPT_ROLE, promptVersion: PROMPT_VERSION, promptHash: PROMPT_HASH, data, commentText })
          .returning({ id: drAgentOutputs.id });
        return inserted!.id;
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") return "stale";
      throw err;
    }
    if (!outputId) return "stale";

    // Submit for human review.
    let expectedVersion = row.version;
    for (let attempt = 1; ; attempt++) {
      try {
        await deps.pipelines.transitionCase({ companyId, caseId, toStageKey: BA_REVIEW_STAGE, expectedVersion, actor: { type: "system" }, reason: "ba_spec_proposed" });
        break;
      } catch (err) {
        const again = err instanceof HttpError && err.status === 409 && attempt < 2 ? await loadCase(companyId, caseId) : null;
        if (again && again.stageKey === BA_STAGE) {
          expectedVersion = again.version;
          continue;
        }
        await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.id, outputId));
        if (err instanceof HttpError && err.status === 409) return "stale";
        throw new BaFailure("transition_failed");
      }
    }
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "devflow-ba",
      agentId: agent.id,
      action: "agent.ba_proposed",
      entityType: "pipeline_case",
      entityId: caseId,
      details: { outputId, promptVersion: PROMPT_VERSION, costUsd, inputTokens, outputTokens, systems: keys },
    });
    return "proposed";
  }

  /** Companies whose BA agent spent today's allowance (UTC day), from DevFlow's own run ledger. */
  async function overBudgetCompanies(): Promise<Array<{ companyId: string; usd: number }>> {
    const cap = deps.maxUsdPerDay ?? 0;
    if (cap <= 0) return [];
    const rows = (await db.execute(sql`
      select company_id, sum((details->>'costUsd')::numeric) as usd
      from activity_log
      where action = 'agent.ba_run'
        and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
      group by company_id having sum((details->>'costUsd')::numeric) >= ${cap}`)) as unknown as Array<{ company_id: string; usd: string | number }>;
    return rows.map((r) => ({ companyId: r.company_id, usd: Number(r.usd) }));
  }

  async function recordBudgetPause(companyId: string, usd: number) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "devflow-ba",
      action: "agent.ba_budget_paused",
      entityType: "company",
      entityId: companyId,
      details: { usdToday: usd, maxUsdPerDay: deps.maxUsdPerDay ?? 0 },
    });
  }

  /** Failure record for dashboards: kind only, never request text or agent output. */
  async function recordFailure(companyId: string, caseId: string, action: "agent.ba_failed" | "agent.ba_gave_up", kind: string, attempts: number) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "devflow-ba",
      action,
      entityType: "pipeline_case",
      entityId: caseId,
      details: { kind, attempts, promptVersion: PROMPT_VERSION },
    });
  }

  return { findPending, baCase, overBudgetCompanies, recordBudgetPause, recordFailure };
}
