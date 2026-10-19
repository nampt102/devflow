import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

// Runs the BA agent once through Paperclip and reads what it said (openspec/changes/add-ba-spec-stage, design D1).
// DevFlow, not the agent, owns the run: the agent cannot call Paperclip (no shell), so nothing else will pick up its answer.

export type BaRunResult = {
  runId: string | null;
  /** the run finished and the agent produced its final message */
  ok: boolean;
  text: string | null;
  /** Claude Code's result subtype, e.g. error_max_budget_usd; the adapter's errorCode can say something else entirely */
  subtype: string | null;
  errorCode: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
};

export interface BaRunner {
  run(input: { companyId: string; agentId: string; caseId: string; reason: string }): Promise<BaRunResult>;
}

type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<{ id: string } | null>;

const NOT_FINISHED = new Set(["queued", "scheduled_retry", "running"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reads a finished run row into the few facts DevFlow needs. Exported for tests. */
export function readRun(row: { id: string; status: string; errorCode: string | null; resultJson: unknown; usageJson: unknown }): BaRunResult {
  const result = rec(row.resultJson);
  const usage = rec(row.usageJson);
  // the CLI engine puts the final message in `result`; the older ACP engine used `summary`
  const text = str(result.result) ?? str(result.summary);
  const subtype = str(result.subtype);
  return {
    runId: row.id,
    ok: row.status === "succeeded" && result.is_error !== true && text !== null && (subtype === null || subtype === "success"),
    text,
    subtype,
    errorCode: row.errorCode,
    costUsd: num(usage.costUsd),
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    model: str(usage.model),
  };
}

export function paperclipRunner(db: Db, wakeup: Wakeup, opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): BaRunner {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async run({ agentId, reason }) {
      const run = await wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason,
        requestedByActorType: "system",
        requestedByActorId: "devflow-ba",
        contextSnapshot: { forceFreshSession: true, triggeredBy: "system" },
      });
      if (!run) return { runId: null, ok: false, text: null, subtype: null, errorCode: "wake_skipped", costUsd: 0, inputTokens: 0, outputTokens: 0, model: null };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const [row] = await db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson, usageJson: heartbeatRuns.usageJson })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run.id));
        if (row && !NOT_FINISHED.has(row.status)) return readRun(row);
        if (Date.now() > deadline) return { runId: run.id, ok: false, text: null, subtype: null, errorCode: "run_timeout", costUsd: 0, inputTokens: 0, outputTokens: 0, model: null };
        await sleep(pollMs);
      }
    },
  };
}
