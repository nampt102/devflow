import type { Db } from "@paperclipai/db";
import { stageMetricsService } from "../agent-stage/metrics.js";

// BA spec quality, cost and flow numbers (openspec change add-ba-spec-stage), on the shared stage metrics.
export const baMetricsService = (db: Db) => stageMetricsService(db, { role: "ba", stageKey: "ba_spec", reviewStageKey: "ba_review" });
