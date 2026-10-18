import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { devflowWorkersDisabled } from "../kill-switch.js";
import { createEmailWorker } from "./email-worker.js";
import { createSender, loadMailConfig } from "./mailer.js";
import { parseRecipients } from "./staff-notify.js";

/** Starts the status-email worker when SMTP is configured; returns null otherwise. */
export function startDevflowEmailFromEnv(db: Db, env: NodeJS.ProcessEnv, shouldRun: () => boolean) {
  if (devflowWorkersDisabled(env)) {
    logger.info("devflow email worker disabled by DEVFLOW_WORKERS_ENABLED");
    return null;
  }
  const config = loadMailConfig(env);
  if (!config) return null;
  const worker = createEmailWorker(db, createSender(config), {
    portalBaseUrl: config.portalBaseUrl,
    delaySeconds: env.DEVFLOW_EMAIL_DELAY_SECONDS ? Number(env.DEVFLOW_EMAIL_DELAY_SECONDS) : undefined,
    maxAgeHours: env.DEVFLOW_EMAIL_MAX_AGE_HOURS ? Number(env.DEVFLOW_EMAIL_MAX_AGE_HOURS) : undefined,
    // staff digest: on whenever email is on; DEVFLOW_STAFF_NOTIFY_ENABLED=false turns it off
    staff: /^(0|false|no|off)$/i.test((env.DEVFLOW_STAFF_NOTIFY_ENABLED ?? "").trim())
      ? undefined
      : {
          portalBaseUrl: config.portalBaseUrl,
          recipients: parseRecipients(env.DEVFLOW_STAFF_NOTIFY_EMAILS),
          intervalMinutes: env.DEVFLOW_STAFF_NOTIFY_INTERVAL_MINUTES ? Number(env.DEVFLOW_STAFF_NOTIFY_INTERVAL_MINUTES) : undefined,
        },
  });
  worker.start(Number(env.DEVFLOW_EMAIL_INTERVAL_MS) || 15_000, shouldRun);
  logger.info({ host: config.host, port: config.port, secure: config.secure }, "devflow email worker started");
  return worker;
}
