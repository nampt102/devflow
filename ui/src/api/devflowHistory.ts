import { api } from "./client";

// The history of one request for staff (openspec change add-request-history): a merged timeline, newest first.

export type HistoryKind = "submitted" | "stage" | "decision" | "field_change" | "proposal" | "agent_run" | "agent_failed" | "email";

export interface HistoryItem {
  at: string;
  kind: HistoryKind;
  actor: string | null;
  summary: string;
  details: Record<string, string | number | boolean | null>;
}

export interface RequestHistory {
  request: {
    caseId: string;
    caseKey: string;
    title: string;
    requestNumber: number;
    requesterName: string;
    createdAt: string;
    stageKey: string;
    stageName: string;
    description: string;
    businessImpact: string | null;
    classification: string | null;
    priority: string | null;
    difficulty: string | null;
    attachments: number;
  };
  items: HistoryItem[];
  costUsd: number;
  stages: Array<{ name: string; enteredAt: string; leftAt: string | null }>;
}

export const devflowHistoryApi = {
  get: (companyId: string, caseRef: string) => api.get<RequestHistory>(`/companies/${companyId}/devflow/requests/${encodeURIComponent(caseRef)}/history`),
};
