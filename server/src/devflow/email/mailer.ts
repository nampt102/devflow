import nodemailer from "nodemailer";

// SMTP sender (Gmail with an app password, or any SMTP server). Errors are reduced to a kind so that
// nothing from the server's reply (which can echo addresses or message text) is stored or logged.

export type MailErrorKind = "auth" | "connection" | "timeout" | "rejected" | "unknown";

export class MailError extends Error {
  constructor(readonly kind: MailErrorKind) {
    super(`mail ${kind}`);
    this.name = "MailError";
  }
}

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  portalBaseUrl: string;
  timeoutMs: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export type SendMail = (msg: MailMessage) => Promise<void>;

/** Null when SMTP is not configured (the email worker then does not start). */
export function loadMailConfig(env: NodeJS.ProcessEnv): MailConfig | null {
  const host = env.DEVFLOW_SMTP_HOST?.trim();
  const from = env.DEVFLOW_SMTP_FROM?.trim();
  if (!host || !from) return null;
  const secure = /^(1|true|yes)$/i.test(env.DEVFLOW_SMTP_SECURE ?? "");
  return {
    host,
    port: Number(env.DEVFLOW_SMTP_PORT) || (secure ? 465 : 587),
    secure,
    user: env.DEVFLOW_SMTP_USER?.trim() || undefined,
    pass: env.DEVFLOW_SMTP_PASS || undefined,
    from,
    portalBaseUrl: (env.DEVFLOW_PORTAL_BASE_URL?.trim() || env.PAPERCLIP_PUBLIC_URL?.trim() || "http://localhost:3100").replace(/\/+$/, ""),
    timeoutMs: Number(env.DEVFLOW_SMTP_TIMEOUT_MS) || 20_000,
  };
}

function kindOf(err: unknown): MailErrorKind {
  const e = err as { code?: string; responseCode?: number };
  if (e.code === "EAUTH") return "auth";
  if (e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT") return "timeout";
  if (e.code === "ECONNECTION" || e.code === "ECONNREFUSED" || e.code === "ESOCKET" || e.code === "ENOTFOUND" || e.code === "ECONNRESET") return "connection";
  if (e.code === "EENVELOPE" || (typeof e.responseCode === "number" && e.responseCode >= 500)) return "rejected";
  return "unknown";
}

export function createSender(config: MailConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
  });
  return async (msg) => {
    try {
      await transport.sendMail({ from: config.from, to: msg.to, subject: msg.subject, text: msg.text });
    } catch (err) {
      throw new MailError(kindOf(err));
    }
  };
}
