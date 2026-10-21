import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { pipelineService } from "../../services/pipelines.js";
import { secretService } from "../../services/secrets.js";
import { DEFAULT_WORKSPACE_ROOT } from "../agent-stage/agent.js";
import { paperclipRunner } from "../agent-stage/runner.js";
import { createStageWorker } from "../agent-stage/worker.js";
import { devflowWorkersDisabled } from "../kill-switch.js";
import { cloneSystem } from "../systems/workspace.js";
import { planService } from "./plan-service.js";

type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<{ id: string } | null>;

/**
 * Starts the Tech Plan worker. It needs the scheduler's wakeup (the agent runs through Paperclip) and is on unless
 * DEVFLOW_WORKERS_ENABLED=false or DEVFLOW_PLAN_ENABLED=false. Without a Planner for a company nothing runs for it.
 */
export function startDevflowPlanFromEnv(db: Db, env: NodeJS.ProcessEnv, wakeup: Wakeup | null, shouldRun: () => boolean) {
  if (devflowWorkersDisabled(env)) {
    logger.info("devflow plan worker disabled by DEVFLOW_WORKERS_ENABLED");
    return null;
  }
  if (env.DEVFLOW_PLAN_ENABLED === "false" || env.DEVFLOW_PLAN_ENABLED === "0") return null;
  if (!wakeup) {
    logger.info("devflow plan worker not started: the heartbeat scheduler is off");
    return null;
  }
  const secrets = secretService(db);
  const workspaceRoot = env.DEVFLOW_AGENT_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
  const worker = createStageWorker(
    db,
    planService(db, {
      pipelines: pipelineService(db),
      runner: paperclipRunner(db, wakeup, { actorId: "devflow-plan" }),
      clone: cloneSystem,
      resolveToken: async (companyId, secretId) =>
        secrets.resolveSecretValue(companyId, secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "devflow-systems", actorType: "system", actorId: "devflow-plan" },
        }),
      workspaceRoot,
      maxUsdPerDay: Number(env.DEVFLOW_PLAN_MAX_USD_PER_DAY) || 0,
    }),
    "plan",
  );
  worker.start(Number(env.DEVFLOW_PLAN_INTERVAL_MS) || 20_000, shouldRun);
  logger.info({ workspaceRoot }, "devflow plan worker started");
  return worker;
}
