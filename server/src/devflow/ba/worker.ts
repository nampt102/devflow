import type { Db } from "@paperclipai/db";
import { createStageWorker, type StageWorkerOptions } from "../agent-stage/worker.js";
import type { baService } from "./ba-service.js";

// The BA worker is the shared stage worker (agent-stage/worker.ts): one agent run at a time for all stages.

export type BaWorkerOptions = StageWorkerOptions;

export function createBaWorker(db: Db, service: ReturnType<typeof baService>, opts: BaWorkerOptions = {}) {
  return createStageWorker(db, service, "ba", opts);
}
