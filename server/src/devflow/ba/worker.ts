import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { BaFailure, type BaFailureKind, type baService } from "./ba-service.js";

// Periodic sweep, one run at a time for the whole instance (the agent's workspace is a single directory that is
// emptied around every run, so no other company's data is ever beside it). Correctness comes from the
// one-`proposed`-per-stage unique index and the version check in baService; the advisory lock only stops several
// server instances from paying for the same run. Failure state (backoff, breaker) is in memory and resets on restart.

export interface BaWorkerOptions {
  batchSize?: number;
  maxAttemptsPerCase?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  configRetryMs?: number;
  now?: () => number;
}

const LOCK_KEY = "dr-ba-worker";

/** Problems with the setup, not with the request: nothing was spent, so they are retried calmly and never given up on. */
const CONFIG_KINDS = new Set<BaFailureKind>([
  "no_agent",
  "agent_not_runnable",
  "agent_wrong_adapter",
  "agent_wrong_engine",
  "agent_wrong_workspace",
  "agent_extra_capability",
  "agent_tools_not_read_only",
  "agent_instance_not_denied",
  "agent_no_budget",
  "agent_prompt_outdated",
  "system_missing_token",
]);

export function createBaWorker(db: Db, service: ReturnType<typeof baService>, opts: BaWorkerOptions = {}) {
  const batchSize = opts.batchSize ?? 3;
  const maxAttempts = opts.maxAttemptsPerCase ?? 3;
  const breakerThreshold = opts.breakerThreshold ?? 3;
  const breakerCooldownMs = opts.breakerCooldownMs ?? 600_000;
  const baseBackoff = opts.baseBackoffMs ?? 60_000;
  const maxBackoff = opts.maxBackoffMs ?? 1_800_000;
  const configRetry = opts.configRetryMs ?? 300_000;
  const now = opts.now ?? Date.now;

  const cases = new Map<string, { failures: number; nextAt: number; gaveUp: boolean; noticed: boolean }>();
  let consecutiveFailures = 0;
  const budgetNoticed = new Set<string>(); // `${companyId}:${utc day}`: log the pause once per day
  let pausedUntil = 0;

  /** Process one case; returns false when the sweep should stop (breaker opened). */
  async function handle(item: { caseId: string; companyId: string }): Promise<boolean> {
    const state = cases.get(item.caseId) ?? { failures: 0, nextAt: 0, gaveUp: false, noticed: false };
    if (state.gaveUp || state.nextAt > now()) return true;
    try {
      await service.baCase(item.companyId, item.caseId);
      cases.delete(item.caseId);
      consecutiveFailures = 0;
      return true;
    } catch (err) {
      const kind: string = err instanceof BaFailure ? err.kind : "unexpected";
      if (!(err instanceof BaFailure)) logger.error({ err }, "devflow ba: unexpected error");
      if (err instanceof BaFailure && CONFIG_KINDS.has(err.kind)) {
        state.nextAt = now() + configRetry;
        const first = !state.noticed;
        state.noticed = true;
        cases.set(item.caseId, state);
        if (first) await service.recordFailure(item.companyId, item.caseId, "agent.ba_failed", kind, 0).catch((e) => logger.warn({ err: e }, "devflow ba: failure not logged"));
        return true;
      }
      state.failures += 1;
      state.nextAt = now() + Math.min(baseBackoff * 2 ** (state.failures - 1), maxBackoff);
      const gaveUp = state.failures >= maxAttempts;
      state.gaveUp = gaveUp;
      cases.set(item.caseId, state);
      consecutiveFailures += 1;
      await service
        .recordFailure(item.companyId, item.caseId, gaveUp ? "agent.ba_gave_up" : "agent.ba_failed", kind, state.failures)
        .catch((e) => logger.warn({ err: e }, "devflow ba: failure not logged"));
      if (consecutiveFailures >= breakerThreshold) {
        pausedUntil = Math.max(pausedUntil, now() + breakerCooldownMs);
        consecutiveFailures = 0;
        logger.warn({ cooldownMs: breakerCooldownMs }, "devflow ba: circuit breaker opened");
      }
      return pausedUntil <= now();
    }
  }

  /** One pass. Returns the number of cases attempted. */
  async function sweep(): Promise<number> {
    if (pausedUntil > now()) return 0;
    let attempted = 0;
    // The lock transaction stays open for the pass (idle connection) and releases on commit or crash.
    await db.transaction(async (lockTx) => {
      const [lock] = await lockTx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as ok`);
      if (!lock?.ok) return;
      const over = await service.overBudgetCompanies();
      const day = new Date(now()).toISOString().slice(0, 10);
      for (const o of over) {
        const key = `${o.companyId}:${day}`;
        if (budgetNoticed.has(key)) continue;
        budgetNoticed.add(key);
        logger.warn({ companyId: o.companyId, usd: o.usd }, "devflow ba: daily spend cap reached, company paused until UTC midnight");
        await service.recordBudgetPause(o.companyId, o.usd).catch((e) => logger.warn({ err: e }, "devflow ba: budget pause not logged"));
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
          .catch((err) => logger.error({ err }, "devflow ba sweep failed"))
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
