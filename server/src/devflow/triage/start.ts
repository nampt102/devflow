import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { costService } from "../../services/costs.js";
import { pipelineService } from "../../services/pipelines.js";
import { loadLlmConfig } from "./llm-client.js";
import { triageService } from "./triage-service.js";
import { createTriageWorker } from "./worker.js";

/** Starts the Triage worker when an LLM endpoint is configured; returns null otherwise. */
export function startDevflowTriageFromEnv(db: Db, env: NodeJS.ProcessEnv, shouldRun: () => boolean) {
  const llm = loadLlmConfig(env);
  if (!llm) return null;
  const worker = createTriageWorker(
    db,
    triageService(db, { pipelines: pipelineService(db), cost: costService(db), llm }),
  );
  worker.start(Number(env.DEVFLOW_TRIAGE_INTERVAL_MS) || 15_000, shouldRun);
  logger.info({ model: llm.model, responseFormat: llm.responseFormat }, "devflow triage worker started");
  return worker;
}
