import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { pipelineService } from "../../services/pipelines.js";
import { secretService } from "../../services/secrets.js";
import { devflowWorkersDisabled } from "../kill-switch.js";
import { cloneSystem } from "../systems/workspace.js";
import { DEFAULT_WORKSPACE_ROOT } from "./agent.js";
import { baService } from "./ba-service.js";
import { paperclipRunner } from "./runner.js";
import { createBaWorker } from "./worker.js";

type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<{ id: string } | null>;

/**
 * Starts the BA worker. It needs the scheduler's wakeup (the agent runs through Paperclip) and is on unless
 * DEVFLOW_WORKERS_ENABLED=false or DEVFLOW_BA_ENABLED=false. Without a BA agent for a company nothing runs for it.
 */
export function startDevflowBaFromEnv(db: Db, env: NodeJS.ProcessEnv, wakeup: Wakeup | null, shouldRun: () => boolean) {
  if (devflowWorkersDisabled(env)) {
    logger.info("devflow ba worker disabled by DEVFLOW_WORKERS_ENABLED");
    return null;
  }
  if (env.DEVFLOW_BA_ENABLED === "false" || env.DEVFLOW_BA_ENABLED === "0") return null;
  if (!wakeup) {
    logger.info("devflow ba worker not started: the heartbeat scheduler is off");
    return null;
  }
  const secrets = secretService(db);
  const workspaceRoot = env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
  const worker = createBaWorker(
    db,
    baService(db, {
      pipelines: pipelineService(db),
      runner: paperclipRunner(db, wakeup),
      clone: cloneSystem,
      resolveToken: async (companyId, secretId) =>
        secrets.resolveSecretValue(companyId, secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "devflow-systems", actorType: "system", actorId: "devflow-ba" },
        }),
      workspaceRoot,
      maxUsdPerDay: Number(env.DEVFLOW_BA_MAX_USD_PER_DAY) || 0,
    }),
  );
  worker.start(Number(env.DEVFLOW_BA_INTERVAL_MS) || 20_000, shouldRun);
  logger.info({ workspaceRoot }, "devflow ba worker started");
  return worker;
}
