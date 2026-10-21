import { api } from "./client";

// Business roles of company staff (openspec change add-approver-roles): who may decide at the review stages.

export interface MemberRoleItem {
  userId: string;
  name: string;
  email: string;
  membershipRole: string | null;
  /** owners pass every role stage without a role */
  alwaysApproves: boolean;
  roles: string[];
}

export interface MemberRolesList {
  availableRoles: string[];
  /** only the company owner (or an instance admin) may change roles */
  canManage: boolean;
  items: MemberRoleItem[];
}

export const devflowRolesApi = {
  list: (companyId: string) => api.get<MemberRolesList>(`/companies/${companyId}/devflow/member-roles`),
  set: (companyId: string, userId: string, roles: string[]) =>
    api.put<{ userId: string; roles: string[]; changed: boolean }>(`/companies/${companyId}/devflow/member-roles/${userId}`, { roles }),
};
