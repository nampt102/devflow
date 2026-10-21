import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { CONFIG_KINDS, StageFailure } from "./failure.js";

// Periodic sweep of one stage. Every stage worker takes the same advisory lock for its whole pass, so the instance runs
// one stage agent at a time (each stage's workspace is a single directory emptied around every run, so no other
// company's data is ever beside the agent). Correctness comes from the one-`proposed`-per-stage unique index and the
// version check in the stage service. Failure state (backoff, breaker) is in memory and resets on restart.

export const STAGE_LOCK_KEY = "dr-agent-stage-worker";

export interface StageWorkerOptions {
  batchSize?: number;
  maxAttemptsPerCase?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  configRetryMs?: number;
  now?: () => number;
}

export interface StageWorkerService {
  findPending(limit: number, excludeCompanyIds?: readonly string[]): Promise<Array<{ caseId: string; companyId: string }>>;
  runCase(companyId: string, caseId: string): Promise<unknown>;
  overBudgetCompanies(): Promise<Array<{ companyId: string; usd: number }>>;
  recordBudgetPause(companyId: string, usd: number): Promise<void>;
  recordFailure(companyId: string, caseId: string, outcome: "failed" | "gave_up", kind: string, attempts: number): Promise<void>;
}

export function createStageWorker(db: Db, service: StageWorkerService, name: string, opts: StageWorkerOptions = {}) {
  const batchSize = opts.batchSize ?? 3;
  const maxAttempts = opts.maxAttemptsPerCase ?? 3;
  const breakerThreshold = opts.breakerThreshold ?? 3;
  const breakerCooldownMs = opts.breakerCooldownMs ?? 600_000;
  const baseBackoff = opts.baseBackoffMs ?? 60_000;
  const maxBackoff = opts.maxBackoffMs ?? 1_800_000;
  const configRetry = opts.configRetryMs ?? 300_000;
  const now = opts.now ?? Date.now;
  const tag = `devflow ${name}`;

  const cases = new Map<string, { failures: number; nextAt: number; gaveUp: boolean; noticed: boolean }>();
  let consecutiveFailures = 0;
  const budgetNoticed = new Set<string>(); // `${companyId}:${utc day}`: log the pause once per day
  let pausedUntil = 0;

  /** Process one case; returns false when the sweep should stop (breaker opened). */
  async function handle(item: { caseId: string; companyId: string }): Promise<boolean> {
    const state = cases.get(item.caseId) ?? { failures: 0, nextAt: 0, gaveUp: false, noticed: false };
    if (state.gaveUp || state.nextAt > now()) return true;
    try {
      await service.runCase(item.companyId, item.caseId);
      cases.delete(item.caseId);
      consecutiveFailures = 0;
      return true;
    } catch (err) {
      const kind: string = err instanceof StageFailure ? err.kind : "unexpected";
      if (!(err instanceof StageFailure)) logger.error({ err }, `${tag}: unexpected error`);
      if (err instanceof StageFailure && CONFIG_KINDS.has(err.kind)) {
        state.nextAt = now() + configRetry;
        const first = !state.noticed;
        state.noticed = true;
        cases.set(item.caseId, state);
        if (first) await service.recordFailure(item.companyId, item.caseId, "failed", kind, 0).catch((e) => logger.warn({ err: e }, `${tag}: failure not logged`));
        return true;
      }
      state.failures += 1;
      state.nextAt = now() + Math.min(baseBackoff * 2 ** (state.failures - 1), maxBackoff);
      const gaveUp = state.failures >= maxAttempts;
      state.gaveUp = gaveUp;
      cases.set(item.caseId, state);
      consecutiveFailures += 1;
      await service
        .recordFailure(item.companyId, item.caseId, gaveUp ? "gave_up" : "failed", kind, state.failures)
        .catch((e) => logger.warn({ err: e }, `${tag}: failure not logged`));
      if (consecutiveFailures >= breakerThreshold) {
        pausedUntil = Math.max(pausedUntil, now() + breakerCooldownMs);
        consecutiveFailures = 0;
        logger.warn({ cooldownMs: breakerCooldownMs }, `${tag}: circuit breaker opened`);
      }
      return pausedUntil <= now();
    }
  }

  /** One pass. Returns the number of cases attempted (0 when another stage worker holds the lock). */
  async function sweep(): Promise<number> {
    if (pausedUntil > now()) return 0;
    let attempted = 0;
    // The lock transaction stays open for the pass (idle connection) and releases on commit or crash.
    await db.transaction(async (lockTx) => {
      const [lock] = await lockTx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${STAGE_LOCK_KEY})) as ok`);
      if (!lock?.ok) return;
      const over = await service.overBudgetCompanies();
      const day = new Date(now()).toISOString().slice(0, 10);
      for (const o of over) {
        const key = `${o.companyId}:${day}`;
        if (budgetNoticed.has(key)) continue;
        budgetNoticed.add(key);
        logger.warn({ companyId: o.companyId, usd: o.usd }, `${tag}: daily spend cap reached, company paused until UTC midnight`);
        await service.recordBudgetPause(o.companyId, o.usd).catch((e) => logger.warn({ err: e }, `${tag}: budget pause not logged`));
      }
      const skip = over.map((o) => o.companyId);
      for (const item of await service.findPending(batchSize, skip)) {
        attempted += 1;
        if (!(await handle(item))) break;
      }
    });
    return attempted;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    sweep,
    start(intervalMs = 20_000, shouldRun: () => boolean = () => true) {
      if (timer) return;
      timer = setInterval(() => {
        if (running || !shouldRun()) return;
        running = true;
        sweep()
          .catch((err) => logger.error({ err }, `${tag} sweep failed`))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
