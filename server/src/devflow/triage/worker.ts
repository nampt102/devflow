import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { TriageFailure, type triageService } from "./triage-service.js";

// Periodic, idempotent sweep: correctness comes from the one-`proposed`-per-stage unique index and the
// version check in triageService; the advisory lock only stops several server instances from paying
// for the same model call. Failure state (backoff, breaker) is in memory and resets on restart.

export interface TriageWorkerOptions {
  batchSize?: number;
  embedBatch?: number;
  maxAttemptsPerCase?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

const LOCK_KEY = "dr-triage-worker";

export function createTriageWorker(db: Db, service: ReturnType<typeof triageService>, opts: TriageWorkerOptions = {}) {
  const batchSize = opts.batchSize ?? 5;
  const embedBatch = opts.embedBatch ?? 20;
  const maxAttempts = opts.maxAttemptsPerCase ?? 5;
  const breakerThreshold = opts.breakerThreshold ?? 5;
  const breakerCooldownMs = opts.breakerCooldownMs ?? 300_000;
  const baseBackoff = opts.baseBackoffMs ?? 30_000;
  const maxBackoff = opts.maxBackoffMs ?? 900_000;
  const now = opts.now ?? Date.now;

  const cases = new Map<string, { failures: number; nextAt: number; gaveUp: boolean }>();
  let consecutiveFailures = 0;
  let pausedUntil = 0;

  /** Process one case; returns false when the sweep should stop (rate limit or breaker opened). */
  async function handle(item: { caseId: string; companyId: string }): Promise<boolean> {
    const state = cases.get(item.caseId) ?? { failures: 0, nextAt: 0, gaveUp: false };
    if (state.gaveUp || state.nextAt > now()) return true;
    try {
      await service.triageCase(item.companyId, item.caseId);
      cases.delete(item.caseId);
      consecutiveFailures = 0;
      return true;
    } catch (err) {
      const kind = err instanceof TriageFailure ? err.kind : "unexpected";
      if (!(err instanceof TriageFailure)) logger.error({ err }, "devflow triage: unexpected error");
      state.failures += 1;
      state.nextAt = now() + Math.min(baseBackoff * 2 ** (state.failures - 1), maxBackoff);
      cases.set(item.caseId, state);
      consecutiveFailures += 1;
      const retryAfter = err instanceof TriageFailure ? err.retryAfterMs : undefined;
      if (retryAfter !== undefined) {
        state.nextAt = Math.max(state.nextAt, now() + retryAfter);
        pausedUntil = Math.max(pausedUntil, now() + retryAfter);
      }
      const gaveUp = state.failures >= maxAttempts;
      state.gaveUp = gaveUp;
      await service
        .recordFailure(item.companyId, item.caseId, gaveUp ? "agent.triage_gave_up" : "agent.triage_failed", kind, state.failures)
        .catch((e) => logger.warn({ err: e }, "devflow triage: failure not logged"));
      if (consecutiveFailures >= breakerThreshold) {
        pausedUntil = Math.max(pausedUntil, now() + breakerCooldownMs);
        consecutiveFailures = 0;
        logger.warn({ cooldownMs: breakerCooldownMs }, "devflow triage: circuit breaker opened");
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
      for (const item of await service.findPending(batchSize)) {
        attempted += 1;
        if (!(await handle(item))) break;
      }
      // Backfill vectors for older requests (no-op without an embedding config or pgvector).
      await service.embedPending(embedBatch).catch((e) => logger.warn({ err: e }, "devflow triage: embed backfill failed"));
    });
    return attempted;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  return {
    sweep,
    start(intervalMs = 15_000, shouldRun: () => boolean = () => true) {
      if (timer) return;
      timer = setInterval(() => {
        if (running || !shouldRun()) return;
        running = true;
        sweep()
          .catch((err) => logger.error({ err }, "devflow triage sweep failed"))
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
