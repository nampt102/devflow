import { api } from "./client";

// Every request of the company by stage, for the Requests board (openspec change add-request-board). Read-only.

export interface BoardColumn {
  key: string;
  name: string;
  kind: "working" | "review" | "done" | "cancelled";
}

export interface BoardCard {
  caseId: string;
  caseKey: string;
  title: string;
  requesterName: string;
  createdAt: string;
  stageKey: string;
  stageEnteredAt: string;
  classification: string | null;
  priority: string | null;
  difficulty: string | null;
  systems: string[];
  waitingFor: "person" | "agent" | null;
  canDecide: boolean;
  /** the review page route (without a leading slash) that holds this request, when a person is waited on */
  reviewPage: string | null;
  lastFailure: { action: string; kind: string | null; at: string } | null;
  terminal: "done" | "cancelled" | null;
}

export interface RequestsBoard {
  columns: BoardColumn[];
  cards: BoardCard[];
}

export const devflowBoardApi = {
  get: (companyId: string, doneLimit = 50) => api.get<RequestsBoard>(`/companies/${companyId}/devflow/requests-board?doneLimit=${doneLimit}`),
};
