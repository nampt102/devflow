import { and, asc, eq, isNull, notExists, sql } from "drizzle-orm";
import {
  agents,
  assets,
  drAgentOutputs,
  drAttachments,
  drRequests,
  pipelineCases,
  pipelineStages,
  pipelines,
  type Db,
} from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";
import { logger } from "../../middleware/logger.js";
import { z } from "zod";
import { PROMPT_HASH, PROMPT_ROLE, PROMPT_VERSION, SYSTEM_PROMPT, buildUserMessage, newBoundary } from "../prompts/triage.v1.js";
import { chatJson, LlmError, type LlmConfig, type LlmErrorKind } from "./llm-client.js";
import { ruleFlags } from "./rules.js";
import { parseTriageOutput, triageOutputSchema, TriageOutputError, REQUIRES_HUMAN_REASONS } from "./schema.js";

export const TRIAGE_PIPELINE_KEY = "dev-request";
const MAX_ATTEMPTS = 2; // one retry when the model's JSON is rejected
const caps = { title: 300, description: 8000, impact: 2000, fileName: 120, files: 10 };

export class TriageFailure extends Error {
  constructor(
    readonly kind: LlmErrorKind | "invalid_output" | "transition_failed",
    readonly retryAfterMs?: number,
  ) {
    super(`triage ${kind}`);
    this.name = "TriageFailure";
  }
}

/** Untrusted text: drop control characters, defuse boundary lookalikes, cap the length. */
export function sanitizeUntrusted(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/DATA-[0-9a-f]{8,}/gi, "[removed]")
    .slice(0, max);
}

type CostService = { createEvent: (companyId: string, data: any) => Promise<unknown> };
type PipelineTransitions = { transitionCase: (input: any) => Promise<unknown> };

export function triageService(
  db: Db,
  deps: { pipelines: PipelineTransitions; cost: CostService; llm: LlmConfig; fetchImpl?: typeof fetch },
) {
  /** One idle agent row per company, only to attribute cost and budget; heartbeat stays disabled. */
  async function ensureTriageAgent(companyId: string): Promise<string> {
    const find = (d: Db) =>
      d
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), sql`${agents.metadata}->>'devflowRole' = ${PROMPT_ROLE}`))
        .then((r) => r[0]?.id);
    const existing = await find(db);
    if (existing) return existing;
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"dr-triage-agent:" + companyId}))`);
      const again = await find(tx as unknown as Db);
      if (again) return again;
      const [row] = await tx
        .insert(agents)
        .values({
          companyId,
          name: "DevFlow Triage",
          role: "general",
          title: "Triage (DevFlow)",
          status: "idle",
          runtimeConfig: { heartbeat: { enabled: false } },
          metadata: { devflowRole: PROMPT_ROLE },
        })
        .returning({ id: agents.id });
      return row.id;
    });
  }

  async function recordUsage(companyId: string, agentId: string, r: { model: string; inputTokens: number; outputTokens: number; requestId: string | null }) {
    try {
      await deps.cost.createEvent(companyId, {
        agentId,
        provider: "openai-compatible",
        billingType: "unknown",
        costStatus: "unpriced", // no price table for the configured model: tokens are real, cost is not invented
        billingCode: "devflow:triage",
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costCents: 0,
        providerRequestId: r.requestId,
        occurredAt: new Date(),
      });
    } catch (err) {
      logger.warn({ err, companyId }, "devflow triage: cost event not recorded");
    }
  }

  /** Cases waiting in `triage` with no live proposal (also re-picks cases sent back by request_changes). */
  async function findPending(limit: number) {
    return db
      .select({ caseId: pipelineCases.id, companyId: pipelineCases.companyId })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
      .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
      .innerJoin(drRequests, and(eq(drRequests.caseId, pipelineCases.id), eq(drRequests.companyId, pipelineCases.companyId)))
      .where(
        and(
          eq(pipelines.key, TRIAGE_PIPELINE_KEY),
          isNull(pipelines.archivedAt),
          eq(pipelineStages.key, "triage"),
          isNull(pipelineCases.terminalKind),
          notExists(
            db
              .select({ one: sql`1` })
              .from(drAgentOutputs)
              .where(
                and(
                  eq(drAgentOutputs.caseId, pipelineCases.id),
                  eq(drAgentOutputs.stageKey, "triage"),
                  eq(drAgentOutputs.status, "proposed"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(pipelineCases.createdAt))
      .limit(limit);
  }

  async function loadCase(companyId: string, caseId: string) {
    const [row] = await db
      .select({
        version: pipelineCases.version,
        title: pipelineCases.title,
        stageKey: pipelineStages.key,
        description: drRequests.description,
        businessImpact: drRequests.businessImpact,
      })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
      .innerJoin(drRequests, and(eq(drRequests.caseId, pipelineCases.id), eq(drRequests.companyId, pipelineCases.companyId)))
      .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId)));
    return row ?? null;
  }

  /** Returns "proposed", or "stale" when the case moved or already has a proposal (nothing written). */
  async function triageCase(companyId: string, caseId: string): Promise<"proposed" | "stale"> {
    const row = await loadCase(companyId, caseId);
    if (!row || row.stageKey !== "triage") return "stale";
    const agentId = await ensureTriageAgent(companyId);

    const files = await db
      .select({ name: assets.originalFilename })
      .from(drAttachments)
      .innerJoin(assets, eq(assets.id, drAttachments.assetId))
      .where(and(eq(drAttachments.caseId, caseId), eq(drAttachments.companyId, companyId)))
      .limit(caps.files);
    const attachmentNames = files.map((f) => sanitizeUntrusted(f.name ?? "(no name)", caps.fileName));
    const candidateCaseKeys: string[] = []; // filled by step 7 (dedupe)

    const messages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserMessage({
          boundary: newBoundary(),
          title: sanitizeUntrusted(row.title, caps.title),
          description: sanitizeUntrusted(row.description, caps.description),
          businessImpact: row.businessImpact ? sanitizeUntrusted(row.businessImpact, caps.impact) : null,
          attachmentNames,
          candidateCaseKeys,
        }),
      },
    ];

    let output: z.infer<typeof triageOutputSchema> | null = null;
    let last: Awaited<ReturnType<typeof chatJson>> | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !output; attempt++) {
      try {
        last = await chatJson(deps.llm, messages, z.toJSONSchema(triageOutputSchema) as Record<string, unknown>, deps.fetchImpl);
      } catch (err) {
        if (err instanceof LlmError) {
          if (err.kind === "truncated" && attempt < MAX_ATTEMPTS) continue;
          throw new TriageFailure(err.kind, err.retryAfterMs);
        }
        throw err;
      }
      inputTokens += last.inputTokens;
      outputTokens += last.outputTokens;
      await recordUsage(companyId, agentId, last);
      try {
        output = parseTriageOutput(last.content, candidateCaseKeys);
      } catch (err) {
        if (!(err instanceof TriageOutputError)) throw err;
        if (attempt === MAX_ATTEMPTS) throw new TriageFailure("invalid_output");
        messages.push({
          role: "user",
          content: `Your previous answer was rejected: ${err.message}. Return only one valid JSON object that follows the schema.`,
        });
      }
    }
    if (!output || !last) throw new TriageFailure("invalid_output");

    // Deterministic flags are unioned with the model's, so the model cannot talk its way out of them.
    const flags = ruleFlags(row.title, row.description, row.businessImpact);
    const reasons = REQUIRES_HUMAN_REASONS.filter((r) => flags.includes(r) || output!.requiresHumanReasons.includes(r));
    const requiresHuman = output.requiresHuman || reasons.length > 0;
    const data = {
      ...output,
      requiresHuman,
      requiresHumanReasons: reasons,
      modelRequiresHumanReasons: output.requiresHumanReasons,
      ruleFlags: flags,
      model: last.model,
      latencyMs: last.latencyMs,
      inputTokens,
      outputTokens,
    };
    const commentText = requiresHuman ? `${output.summary}\n\nCần người thực hiện: ${reasons.join(", ") || "model đề nghị"}.` : output.summary;

    // First writer wins: the unique index allows one live proposal per stage, so a concurrent run
    // (or a proposal left by an earlier pass) makes this one stale. Decided outputs are marked by the review step.
    let outputId: string | null;
    try {
      outputId = await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select({ version: pipelineCases.version, stageKey: pipelineStages.key })
          .from(pipelineCases)
          .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
          .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId)))
          .for("update", { of: pipelineCases });
        if (!fresh || fresh.stageKey !== "triage" || fresh.version !== row.version) return null;
        const [inserted] = await tx
          .insert(drAgentOutputs)
          .values({
            companyId,
            caseId,
            stageKey: "triage",
            agentId,
            promptRole: PROMPT_ROLE,
            promptVersion: PROMPT_VERSION,
            promptHash: PROMPT_HASH,
            data,
            commentText,
          })
          .returning({ id: drAgentOutputs.id });
        return inserted.id;
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") return "stale";
      throw err;
    }
    if (!outputId) return "stale";

    // Submit for human review. pendingSuggestion is not used: moving out of a working stage needs no approval.
    let expectedVersion = row.version;
    for (let attempt = 1; ; attempt++) {
      try {
        await deps.pipelines.transitionCase({
          companyId,
          caseId,
          toStageKey: "triage_review",
          expectedVersion,
          actor: { type: "system" },
          reason: "triage_proposed",
        });
        break;
      } catch (err) {
        const again = err instanceof HttpError && err.status === 409 && attempt < 2 ? await loadCase(companyId, caseId) : null;
        if (again && again.stageKey === "triage") {
          expectedVersion = again.version;
          continue;
        }
        await db.update(drAgentOutputs).set({ status: "superseded" }).where(eq(drAgentOutputs.id, outputId));
        if (err instanceof HttpError && err.status === 409) return "stale";
        throw new TriageFailure("transition_failed");
      }
    }
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "devflow-triage",
      agentId,
      action: "agent.triage_proposed",
      entityType: "pipeline_case",
      entityId: caseId,
      details: { outputId, promptVersion: PROMPT_VERSION, inputTokens, outputTokens, latencyMs: last.latencyMs },
    });
    return "proposed";
  }

  /** Failure record for dashboards: kind only, never request text or model output. */
  async function recordFailure(companyId: string, caseId: string, action: "agent.triage_failed" | "agent.triage_gave_up", kind: string, attempts: number) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "devflow-triage",
      action,
      entityType: "pipeline_case",
      entityId: caseId,
      details: { kind, attempts, promptVersion: PROMPT_VERSION },
    });
  }

  return { ensureTriageAgent, findPending, triageCase, recordFailure };
}
