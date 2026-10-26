import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { pipelineService } from "../../services/pipelines.js";
import { secretService } from "../../services/secrets.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { paperclipRunner } from "../agent-stage/runner.js";
import { createStageWorker } from "../agent-stage/worker.js";
import { devflowWorkersDisabled } from "../kill-switch.js";
import { qaService } from "./qa-service.js";

type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<{ id: string } | null>;

/**
 * Starts the QA worker. It needs the scheduler's wakeup (the agent runs through Paperclip, on the runner) and is on unless
 * DEVFLOW_WORKERS_ENABLED=false or DEVFLOW_QA_ENABLED=false. Nothing runs for a company without a QA agent. It shares the
 * stage lock, so a QA run (up to 40 minutes) holds back the other stages' runs of the instance while it works.
 */
export function startDevflowQaFromEnv(db: Db, env: NodeJS.ProcessEnv, wakeup: Wakeup | null, shouldRun: () => boolean) {
  if (devflowWorkersDisabled(env)) {
    logger.info("devflow qa worker disabled by DEVFLOW_WORKERS_ENABLED");
    return null;
  }
  if (env.DEVFLOW_QA_ENABLED === "false" || env.DEVFLOW_QA_ENABLED === "0") return null;
  if (!wakeup) {
    logger.info("devflow qa worker not started: the heartbeat scheduler is off");
    return null;
  }
  const secrets = secretService(db);
  const workspaceRoot = env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
  const worker = createStageWorker(
    db,
    qaService(db, {
      pipelines: pipelineService(db),
      // a QA run can take 40 minutes (the agent's own timeout); wait a little longer than that
      runner: paperclipRunner(db, wakeup, { actorId: "devflow-qa", timeoutMs: 50 * 60_000 }),
      resolveToken: async (companyId, secretId) =>
        secrets.resolveSecretValue(companyId, secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "devflow-systems", actorType: "system", actorId: "devflow-qa" },
        }),
      workspaceRoot,
      maxUsdPerDay: Number(env.DEVFLOW_QA_MAX_USD_PER_DAY) || 0,
    }),
    "qa",
  );
  worker.start(Number(env.DEVFLOW_QA_INTERVAL_MS) || 30_000, shouldRun);
  logger.info({ workspaceRoot }, "devflow qa worker started");
  return worker;
}
