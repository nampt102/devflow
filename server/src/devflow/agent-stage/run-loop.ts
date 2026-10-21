import os from "node:os";
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
import { newBoundary } from "../prompts/ba.v1.js";
import { TRIAGE_PIPELINE_KEY, sanitizeUntrusted } from "../triage/triage-service.js";
import type { cloneSystem } from "../systems/workspace.js";
import { DEFAULT_WORKSPACE_ROOT, findStageAgent, type StageAgentRow, type StageRole } from "./agent.js";
import { StageFailure, type StageFailureKind } from "./failure.js";
import { AgentOutputError } from "./output.js";
import type { StageRunner } from "./runner.js";
import { stageWorkspace, type ClonedSystem } from "./workspace.js";

// One stage agent run for one request (ADR 0021): prepare the workspace, run the agent through Paperclip, check what it
// said, store it as a proposal and send the request to the stage's review. BA Spec and Tech Plan differ only in the
// definition passed here.

const MAX_ATTEMPTS = 2; // one more run when the agent's JSON is rejected
export const caps = { title: 300, description: 8000, impact: 2000, fileName: 120, files: 10, feedback: 1000, summary: 300 };

export type StageRequestInput = {
  boundary: string;
  caseKey: string;
  title: string;
  description: string;
  businessImpact: string | null;
  attachmentNames: readonly string[];
  triage: { classification: string; priority: string; difficulty: string } | null;
  systems: readonly ClonedSystem[];
  feedback: { previousSummary: string; text: string } | null;
};

export type StageDefinition<O, C> = {
  role: StageRole;
  stageKey: string;
  reviewStageKey: string;
  /** the system actor of logs and wakeups, e.g. devflow-ba */
  actorId: string;
  prompt: { version: string; hash: string };
  /** what the agent writes, for the correction message ("spec", "plan") */
  artifact: string;
  /** reason recorded on the transition to review */
  proposedReason: string;
  unsafeReason: (agent: StageAgentRow, workspaceRoot: string) => string | null;
  /** Extra input read before anything is prepared; may throw StageFailure (e.g. no approved spec). */
  loadContext: (companyId: string, caseId: string) => Promise<C>;
  buildRequest: (input: StageRequestInput, context: C) => string;
  parse: (text: string, systemKeys: readonly string[]) => O;
  comment: (output: O) => string;
};

type PipelineTransitions = { transitionCase: (input: any) => Promise<unknown> };

export type StageServiceDeps = {
  pipelines: PipelineTransitions;
  runner: StageRunner;
  clone: typeof cloneSystem;
  /** reads the token of a system's secret; null when the secret is gone */
  resolveToken: (companyId: string, secretId: string) => Promise<string | null>;
  workspaceRoot?: string;
  /** HOME of the agent's Claude Code process (its transcripts live under `.claude/projects`) */
  claudeHome?: string;
  maxUsdPerDay?: number;
};

export function stageService<O extends Record<string, unknown>, C>(db: Db, def: StageDefinition<O, C>, deps: StageServiceDeps) {
  const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const workspace = stageWorkspace({
    role: def.role,
    root,
    claudeHome: deps.claudeHome ?? process.env.HOME ?? os.homedir(),
    clone: deps.clone,
    resolveToken: deps.resolveToken,
  });
  const action = (what: "run" | "proposed" | "failed" | "gave_up" | "budget_paused") => `agent.${def.role}_${what}`;

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

  /** Cases waiting in the stage with no live proposal (also re-picks cases sent back by request_changes). */
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
          eq(pipelineStages.key, def.stageKey),
          isNull(pipelineCases.terminalKind),
          notExists(
            db
              .select({ one: sql`1` })
              .from(drAgentOutputs)
              .where(and(eq(drAgentOutputs.caseId, pipelineCases.id), eq(drAgentOutputs.stageKey, def.stageKey), eq(drAgentOutputs.status, "proposed"))),
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

  /** After request_changes: the reviewer's reason and the summary of the proposal that was sent back. */
  async function loadFeedback(companyId: string, caseId: string): Promise<{ previousSummary: string; text: string } | null> {
    const [prev] = await db
      .select({ data: drAgentOutputs.data, createdAt: drAgentOutputs.createdAt })
      .from(drAgentOutputs)
      .where(and(eq(drAgentOutputs.caseId, caseId), eq(drAgentOutputs.stageKey, def.stageKey), eq(drAgentOutputs.status, "superseded")))
      .orderBy(desc(drAgentOutputs.createdAt))
      .limit(1);
    if (!prev) return null;
    // only a decision made after that proposal existed: an older request_changes belongs to an earlier stage
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

  async function recordRun(companyId: string, caseId: string, agentId: string, r: { runId: string | null; ok: boolean; costUsd: number; inputTokens: number; outputTokens: number }, kind: string | null) {
    // DevFlow's own ledger for the daily cap: Paperclip's accounting of a run can lag behind the run
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: def.actorId,
      agentId,
      action: action("run"),
      entityType: "pipeline_case",
      entityId: caseId,
      details: { runId: r.runId, ok: r.ok, kind, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, promptVersion: def.prompt.version },
    }).catch((e) => logger.warn({ err: e }, `devflow ${def.role}: run not logged`));
  }

  /** Returns "proposed", or "stale" when the case moved or already has a proposal (nothing written). */
  async function runCase(companyId: string, caseId: string): Promise<"proposed" | "stale"> {
    const row = await loadCase(companyId, caseId);
    if (!row || row.stageKey !== def.stageKey) return "stale";

    const agent = await findStageAgent(db, companyId, def.role);
    if (!agent) throw new StageFailure("no_agent");
    const unsafe = def.unsafeReason(agent, root);
    if (unsafe) throw new StageFailure(unsafe as StageFailureKind);

    const context = await def.loadContext(companyId, caseId);
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

    let output: O | null = null;
    let repos: ClonedSystem[] = [];
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let model: string | null = null;
    let runId: string | null = null;
    let correction: string | null = null;
    try {
      await workspace.reset();
      repos = await workspace.cloneAll(companyId, systems);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !output; attempt++) {
        const requestFile =
          def.buildRequest(
            {
              boundary: newBoundary(),
              caseKey: row.caseKey,
              title: sanitizeUntrusted(row.title, caps.title),
              description: sanitizeUntrusted(row.description, caps.description),
              businessImpact: row.businessImpact ? sanitizeUntrusted(row.businessImpact, caps.impact) : null,
              attachmentNames,
              triage: row.classification && row.priority && row.difficulty ? { classification: row.classification, priority: row.priority, difficulty: row.difficulty } : null,
              systems: repos,
              feedback,
            },
            context,
          ) +
          (correction
            ? `\n## Correction (DevFlow's own text)\nYour previous answer was rejected: ${correction}. Write the ${def.artifact} again and return only one valid JSON object that follows the schema.\n`
            : "");
        await workspace.writeRequest(requestFile);
        const result = await deps.runner.run({ companyId, agentId: agent.id, caseId, reason: `devflow_${def.role}:${row.caseKey}` });
        costUsd += result.costUsd;
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;
        model = result.model ?? model;
        runId = result.runId ?? runId;
        if (!result.ok || !result.text) {
          const kind: StageFailureKind =
            result.subtype === "error_max_budget_usd" ? "budget_exhausted" : result.errorCode === "run_timeout" ? "run_timeout" : result.errorCode === "wake_skipped" ? "wake_skipped" : "run_failed";
          await recordRun(companyId, caseId, agent.id, result, kind);
          throw new StageFailure(kind);
        }
        await recordRun(companyId, caseId, agent.id, result, null);
        try {
          output = def.parse(result.text, keys);
        } catch (err) {
          if (!(err instanceof AgentOutputError)) throw err;
          if (attempt === MAX_ATTEMPTS) throw new StageFailure("invalid_output");
          correction = err.message;
        }
      }
    } finally {
      await workspace.clear();
    }
    if (!output) throw new StageFailure("invalid_output");

    const data = {
      ...output,
      repos: repos.map((r) => ({ system: r.key, sha: r.sha })),
      model,
      runId,
      costUsd,
      inputTokens,
      outputTokens,
    };
    const commentText = def.comment(output);

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
        if (!fresh || fresh.stageKey !== def.stageKey || fresh.version !== row.version) return null;
        const [inserted] = await tx
          .insert(drAgentOutputs)
          .values({ companyId, caseId, stageKey: def.stageKey, agentId: agent.id, runId: runRow?.id ?? null, promptRole: def.role, promptVersion: def.prompt.version, promptHash: def.prompt.hash, data, commentText })
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
        await deps.pipelines.transitionCase({ companyId, caseId, toStageKey: def.reviewStageKey, expectedVersion, actor: { type: "system" }, reason: def.proposedReason });
        break;
      } catch (err) {
        const again = err instanceof HttpError && err.status === 409 && attempt < 2 ? await loadCase(companyId, caseId) : null;
        if (again && again.stageKey === def.stageKey) {
          expectedVersion = again.version;
          continue;
        }
        await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.id, outputId));
        if (err instanceof HttpError && err.status === 409) return "stale";
        throw new StageFailure("transition_failed");
      }
    }
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: def.actorId,
      agentId: agent.id,
      action: action("proposed"),
      entityType: "pipeline_case",
      entityId: caseId,
      details: { outputId, promptVersion: def.prompt.version, costUsd, inputTokens, outputTokens, systems: keys },
    });
    return "proposed";
  }

  /** Companies whose stage agent spent today's allowance (UTC day), from DevFlow's own run ledger. */
  async function overBudgetCompanies(): Promise<Array<{ companyId: string; usd: number }>> {
    const cap = deps.maxUsdPerDay ?? 0;
    if (cap <= 0) return [];
    const rows = (await db.execute(sql`
      select company_id, sum((details->>'costUsd')::numeric) as usd
      from activity_log
      where action = ${action("run")}
        and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
      group by company_id having sum((details->>'costUsd')::numeric) >= ${cap}`)) as unknown as Array<{ company_id: string; usd: string | number }>;
    return rows.map((r) => ({ companyId: r.company_id, usd: Number(r.usd) }));
  }

  async function recordBudgetPause(companyId: string, usd: number) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: def.actorId,
      action: action("budget_paused"),
      entityType: "company",
      entityId: companyId,
      details: { usdToday: usd, maxUsdPerDay: deps.maxUsdPerDay ?? 0 },
    });
  }

  /** Failure record for dashboards: kind only, never request text or agent output. */
  async function recordFailure(companyId: string, caseId: string, outcome: "failed" | "gave_up", kind: string, attempts: number) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: def.actorId,
      action: action(outcome),
      entityType: "pipeline_case",
      entityId: caseId,
      details: { kind, attempts, promptVersion: def.prompt.version },
    });
  }

  return { findPending, runCase, overBudgetCompanies, recordBudgetPause, recordFailure };
}

export type StageService = ReturnType<typeof stageService>;
