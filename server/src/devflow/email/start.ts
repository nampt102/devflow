import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { createEmailWorker } from "./email-worker.js";
import { createSender, loadMailConfig } from "./mailer.js";

/** Starts the status-email worker when SMTP is configured; returns null otherwise. */
export function startDevflowEmailFromEnv(db: Db, env: NodeJS.ProcessEnv, shouldRun: () => boolean) {
  const config = loadMailConfig(env);
  if (!config) return null;
  const worker = createEmailWorker(db, createSender(config), {
    portalBaseUrl: config.portalBaseUrl,
    delaySeconds: env.DEVFLOW_EMAIL_DELAY_SECONDS ? Number(env.DEVFLOW_EMAIL_DELAY_SECONDS) : undefined,
    maxAgeHours: env.DEVFLOW_EMAIL_MAX_AGE_HOURS ? Number(env.DEVFLOW_EMAIL_MAX_AGE_HOURS) : undefined,
  });
  worker.start(Number(env.DEVFLOW_EMAIL_INTERVAL_MS) || 15_000, shouldRun);
  logger.info({ host: config.host, port: config.port, secure: config.secure }, "devflow email worker started");
  return worker;
}
