import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { costService } from "../../services/costs.js";
import { pipelineService } from "../../services/pipelines.js";
import { loadDedupeConfig } from "./dedupe.js";
import { loadEmbedConfig } from "./embed-client.js";
import { loadLlmConfig } from "./llm-client.js";
import { triageService } from "./triage-service.js";
import { devflowWorkersDisabled } from "../kill-switch.js";
import { createTriageWorker } from "./worker.js";

/** Starts the Triage worker when an LLM endpoint is configured; returns null otherwise. */
export function startDevflowTriageFromEnv(db: Db, env: NodeJS.ProcessEnv, shouldRun: () => boolean) {
  if (devflowWorkersDisabled(env)) {
    logger.info("devflow triage worker disabled by DEVFLOW_WORKERS_ENABLED");
    return null;
  }
  const llm = loadLlmConfig(env);
  if (!llm) return null;
  const worker = createTriageWorker(
    db,
    triageService(db, {
      pipelines: pipelineService(db),
      cost: costService(db),
      llm,
      embed: loadEmbedConfig(env),
      dedupe: loadDedupeConfig(env),
      maxTokensPerDay: Number(env.DEVFLOW_TRIAGE_MAX_TOKENS_PER_DAY) || 0,
    }),
  );
  worker.start(Number(env.DEVFLOW_TRIAGE_INTERVAL_MS) || 15_000, shouldRun);
  logger.info({ model: llm.model, responseFormat: llm.responseFormat, embedModel: loadEmbedConfig(env)?.model ?? null }, "devflow triage worker started");
  return worker;
}
