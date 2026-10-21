import { api } from "./client";

// Systems catalog (openspec change add-ba-spec-stage): the repositories a company's requests can be about.

export interface DevflowSystem {
  id: string;
  key: string;
  name: string;
  description: string;
  repoUrl: string;
  defaultBranch: string;
  docsPath: string;
  active: boolean;
  hasToken: boolean;
  devEnabled: boolean;
  hasWriteToken: boolean;
  testCommand: string | null;
  forbiddenPaths: string[];
  allowUnprotected: boolean;
  updatedAt: string;
}

export interface NewSystem {
  key: string;
  name: string;
  description: string;
  repoUrl: string;
  defaultBranch: string;
  docsPath: string;
  token?: string;
}

export interface SystemChanges {
  name?: string;
  description?: string;
  defaultBranch?: string;
  docsPath?: string;
  active?: boolean;
  /** a string replaces the token, null removes it */
  token?: string | null;
  // agent Dev (add-dev-stage)
  devEnabled?: boolean;
  /** a string replaces the write token, null removes it */
  writeToken?: string | null;
  testCommand?: string | null;
  forbiddenPaths?: string[];
  allowUnprotected?: boolean;
}

export const devflowSystemsApi = {
  list: (companyId: string) => api.get<{ items: DevflowSystem[] }>(`/companies/${companyId}/devflow/systems`),
  create: (companyId: string, input: NewSystem) => api.post<DevflowSystem>(`/companies/${companyId}/devflow/systems`, input),
  update: (companyId: string, systemId: string, changes: SystemChanges) => api.patch<DevflowSystem>(`/companies/${companyId}/devflow/systems/${systemId}`, changes),
};
