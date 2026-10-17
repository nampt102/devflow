import { vi } from "./vi";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export type Attachment = { id: string; filename: string; contentType: string; byteSize: number; createdAt: string };
export type RequestItem = {
  code: string;
  number: number;
  title: string;
  description: string;
  businessImpact: string | null;
  statusLabel: string;
  createdAt: string;
  updatedAt: string;
  attachments?: Attachment[];
};
export type SessionUser = { id: string; name: string; email: string };

/** Pulls a machine code and message out of the different error shapes the server and better-auth return. */
export function readErrorBody(body: unknown, status: number): { code?: string; message: string } {
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const details = (obj.details && typeof obj.details === "object" ? obj.details : {}) as Record<string, unknown>;
  const code = [details.code, obj.code].find((v): v is string => typeof v === "string");
  const raw = obj.error ?? obj.message;
  return { code, message: typeof raw === "string" ? raw : `HTTP ${status}` };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !isForm ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", vi.errors.network);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const { code, message } = readErrorBody(json, response.status);
    throw new ApiError(response.status, code, message);
  }
  return json as T;
}

export const api = {
  async session(): Promise<SessionUser | null> {
    const data = await call<{ user?: SessionUser } | null>("GET", "/api/auth/get-session");
    return data?.user ?? null;
  },
  signIn: (email: string, password: string) => call<unknown>("POST", "/api/auth/sign-in/email", { email, password }),
  signOut: () => call<unknown>("POST", "/api/auth/sign-out", {}),
  me: () => call<{ companyId: string; requesterId: string }>("GET", "/api/portal/me"),
  /** Creates the account and the requester in one step; the caller signs in afterwards. */
  registerWithInvite: (token: string, name: string, email: string, password: string) =>
    call<{ companyId: string; requesterId: string }>("POST", `/api/portal/invites/${token}/register`, { name, email, password }),
  acceptInvite: (token: string) => call<{ companyId: string; requesterId: string }>("POST", `/api/portal/invites/${token}/accept`, {}),
  list: () => call<{ items: RequestItem[] }>("GET", "/api/portal/requests"),
  get: (number: number) => call<RequestItem>("GET", `/api/portal/requests/${number}`),
  submit(input: { title: string; description: string; businessImpact: string }, files: File[]) {
    const form = new FormData();
    form.set("title", input.title);
    form.set("description", input.description);
    if (input.businessImpact.trim()) form.set("businessImpact", input.businessImpact);
    for (const file of files) form.append("files", file);
    return call<RequestItem>("POST", "/api/portal/requests", form);
  },
  addFiles(number: number, files: File[]) {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return call<RequestItem>("POST", `/api/portal/requests/${number}/attachments`, form);
  },
  attachmentUrl: (number: number, id: string) => `/api/portal/requests/${number}/attachments/${id}`,
};

/** Turns any thrown value into a Vietnamese sentence for the user. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return vi.errors.generic;
  const e = vi.errors;
  const byCode: Record<string, string> = {
    INVALID_EMAIL_OR_PASSWORD: e.badCredentials,
    USER_ALREADY_EXISTS: e.emailTaken,
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: e.emailTaken,
    PASSWORD_TOO_SHORT: e.weakPassword,
    account_exists: e.accountExists,
    invite_used: e.inviteUsed,
    invite_expired: e.inviteExpired,
    invite_revoked: e.inviteRevoked,
    invite_unavailable: e.inviteUsed,
    file_too_large: e.fileTooLarge,
    unsupported_type: e.fileType,
    content_mismatch: e.fileContent,
    too_many_files: e.tooManyFiles,
    pipeline_missing: e.pipelineMissing,
    network: e.network,
  };
  if (err.code && byCode[err.code]) return byCode[err.code];
  switch (err.status) {
    case 400:
      return e.requiredField;
    case 401:
      return e.sessionExpired;
    case 403:
      return e.notRequester;
    case 404:
      return err.message.toLowerCase().includes("invitation") ? e.inviteInvalid : e.notFound;
    case 410:
      return e.inviteUsed;
    case 429:
      return e.tooManyRequests;
    default:
      return e.generic;
  }
}
