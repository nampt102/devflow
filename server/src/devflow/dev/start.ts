import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { pipelineService } from "../../services/pipelines.js";
import { secretService } from "../../services/secrets.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { paperclipRunner } from "../agent-stage/runner.js";
import { createStageWorker } from "../agent-stage/worker.js";
import { devflowWorkersDisabled } from "../kill-switch.js";
import { devService } from "./dev-service.js";

type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<{ id: string } | null>;

/**
 * Starts the Dev worker. It needs the scheduler's wakeup (the agent runs through Paperclip, on the runner) and is on
 * unless DEVFLOW_WORKERS_ENABLED=false or DEVFLOW_DEV_ENABLED=false. Nothing runs for a company without a Dev agent, and
 * only systems that were switched on for Dev (with a write token) are ever coded. It shares the stage lock, so a Dev
 * run (up to an hour) holds back BA and Tech Plan runs of the instance while it works.
 */
export function startDevflowDevFromEnv(db: Db, env: NodeJS.ProcessEnv, wakeup: Wakeup | null, shouldRun: () => boolean) {
  if (devflowWorkersDisabled(env)) {
    logger.info("devflow dev worker disabled by DEVFLOW_WORKERS_ENABLED");
    return null;
  }
  if (env.DEVFLOW_DEV_ENABLED === "false" || env.DEVFLOW_DEV_ENABLED === "0") return null;
  if (!wakeup) {
    logger.info("devflow dev worker not started: the heartbeat scheduler is off");
    return null;
  }
  const secrets = secretService(db);
  const workspaceRoot = env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
  const worker = createStageWorker(
    db,
    devService(db, {
      pipelines: pipelineService(db),
      // a Dev run can take an hour (the agent's own timeout); wait a little longer than that
      runner: paperclipRunner(db, wakeup, { actorId: "devflow-dev", timeoutMs: 70 * 60_000 }),
      resolveToken: async (companyId, secretId) =>
        secrets.resolveSecretValue(companyId, secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "devflow-systems", actorType: "system", actorId: "devflow-dev" },
        }),
      workspaceRoot,
      maxUsdPerDay: Number(env.DEVFLOW_DEV_MAX_USD_PER_DAY) || 0,
      maxDiffLines: Number(env.DEVFLOW_DEV_MAX_DIFF_LINES) || undefined,
    }),
    "dev",
  );
  worker.start(Number(env.DEVFLOW_DEV_INTERVAL_MS) || 30_000, shouldRun);
  logger.info({ workspaceRoot }, "devflow dev worker started");
  return worker;
}
