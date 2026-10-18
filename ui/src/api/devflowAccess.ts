import { api } from "./client";

// Portal access (DevFlow backlog A-11): requester invite links and staff accounts.

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

export interface PortalInvite {
  id: string;
  label: string | null;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedInvite extends PortalInvite {
  /** Shown once: only its hash is stored on the server. */
  token: string;
  path: string;
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
  membershipRole: string | null;
  status: string;
  hasPassword: boolean;
}

export const devflowAccessApi = {
  invites: (companyId: string) => api.get<{ items: PortalInvite[] }>(`/companies/${companyId}/portal/invites`),
  createInvite: (companyId: string, label: string) => api.post<CreatedInvite>(`/companies/${companyId}/portal/invites`, label.trim() ? { label: label.trim() } : {}),
  revokeInvite: (companyId: string, inviteId: string) => api.post<PortalInvite>(`/companies/${companyId}/portal/invites/${inviteId}/revoke`, {}),
  users: (companyId: string) => api.get<{ items: CompanyUser[] }>(`/admin/users?companyId=${companyId}`),
  createUser: (input: { name: string; email: string; companyIds: string[] }) =>
    api.post<{ user: { id: string; name: string; email: string }; companyIds: string[]; password?: string }>(`/admin/users`, input),
  resetPassword: (userId: string) => api.post<{ user: { id: string; email: string }; sessionsRevoked: number; password?: string }>(`/admin/users/${userId}/reset-password`, {}),
};
