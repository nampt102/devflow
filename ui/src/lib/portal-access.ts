import type { InviteStatus } from "../api/devflowAccess";

// Pure helpers for the DevFlow "Portal access" page.

/** The link a requester opens: the server returns only the path, the origin is the one the staff member is on. */
export const inviteUrl = (origin: string, path: string): string => `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  pending: "Waiting",
  accepted: "Used",
  expired: "Expired",
  revoked: "Revoked",
};

/** "6 days left", "today", "expired": what the staff member needs to decide whether to send a new link. */
export function expiryLabel(expiresAt: string | Date, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const days = Math.ceil(ms / 86_400_000);
  return days <= 1 ? "less than a day left" : `${days} days left`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (value: string): boolean => value.length <= 254 && EMAIL.test(value.trim());

/** Errors the staff member can act on, from the server's `{ error, code }` body. */
export function accessErrorMessage(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const body = (error as { body?: { code?: string; error?: string } } | null)?.body;
  if (body?.code === "account_exists") return "An account with this email already exists.";
  if (body?.code === "settings_operator_managed") return "Accounts are managed by the hosting operator on this instance.";
  if (body?.code === "no_credential_account") return "This person signs in another way and has no password to reset.";
  if (status === 403) return "You do not have permission for this.";
  if (status === 404) return "Not found or no longer available.";
  return body?.error || (error instanceof Error ? error.message : "Something went wrong. Try again.");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
