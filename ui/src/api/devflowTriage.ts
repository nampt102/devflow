import { api } from "./client";

// Staff review of Triage proposals (DevFlow step 8, openspec/decisions/0017).

export type TriageClassification = "bug" | "feature" | "request";
export type TriagePriority = "urgent" | "high" | "medium" | "low";
export type TriageDifficulty = "easy" | "medium" | "hard";
export type TriageDecision = "approve" | "reject" | "request_changes";

export interface TriageProposalSummary {
  classification: TriageClassification;
  priority: TriagePriority;
  difficulty: TriageDifficulty;
  requiresHuman: boolean;
  requiresHumanReasons: string[];
  ruleFlags: string[];
  confidence: number | null;
  summary: string;
  duplicateCandidates: number;
}

export interface TriageQueueItem {
  caseId: string;
  caseKey: string;
  requestNumber: number;
  title: string;
  requesterName: string;
  attachments: number;
  createdAt: string;
  version: number;
  outputId: string;
  promptVersion: string;
  proposal: TriageProposalSummary;
}

export interface TriageCandidate {
  caseId: string;
  caseKey: string;
  requestNumber: number;
  title: string;
  statusLabel: string;
  trigram: number | null;
  vector: number | null;
  modelReason: string | null;
  namedByModel: boolean;
}

export interface TriageDetail {
  caseId: string;
  caseKey: string;
  requestNumber: number;
  title: string;
  description: string;
  businessImpact: string | null;
  requesterName: string;
  createdAt: string;
  version: number;
  attachments: Array<{ id: string; name: string | null; contentType: string | null; size: number | null; contentPath: string }>;
  outputId: string;
  promptVersion: string;
  model: string | null;
  proposal: TriageProposalSummary & {
    classificationReason: string;
    priorityReason: string;
    difficultyReason: string;
    assumptions: string[];
    openQuestions: string[];
    modelRequiresHumanReasons: string[];
    dedupeMode: string | null;
  };
  candidates: TriageCandidate[];
}

export interface TriageFinalPatch {
  classification?: TriageClassification;
  priority?: TriagePriority;
  difficulty?: TriageDifficulty;
  requiresHuman?: boolean;
  requiresHumanReasons?: string[];
  duplicateOfCaseId?: string | null;
}

export interface TriageDecisionBody {
  outputId: string;
  expectedVersion: number;
  decision: TriageDecision;
  reason?: string;
  final?: TriageFinalPatch;
}

export interface TriageMetrics {
  windowDays: number;
  approved: { total: number; overridden: number; overrideRate: number | null; byPromptVersion: Array<{ promptVersion: string; total: number; overridden: number; overrideRate: number | null }> };
  fields: Array<{ field: string; overrides: number; rate: number | null }>;
  commonCorrections: Array<{ field: string; agentValue: string | null; finalValue: string | null; count: number }>;
  decisions: { approve: number; reject: number; requestChanges: number };
  duplicates: { namedByAgent: number; addedByReviewer: number; closedAsDuplicate: number };
  flow: { secondsToProposal: { p50: number | null; p90: number | null }; secondsInReview: { p50: number | null; p90: number | null }; secondsToApproval: { p50: number | null } };
  queue: { waiting: number; oldestSince: string | null };
  recentFailures: Array<{ action: string; kind: string | null; caseKey: string | null; at: string }>;
  agent: { proposed: number; failed: number; gaveUp: number; embedFailed: number; emailFailed: number; budgetPaused: number; calls: number; inputTokens: number; outputTokens: number };
}

export const devflowTriageApi = {
  metrics: (companyId: string, days = 30) => api.get<TriageMetrics>(`/companies/${companyId}/devflow/triage-metrics?days=${days}`),
  queue: (companyId: string) => api.get<{ items: TriageQueueItem[] }>(`/companies/${companyId}/devflow/triage-queue`),
  detail: (companyId: string, caseId: string) => api.get<TriageDetail>(`/companies/${companyId}/devflow/triage-cases/${caseId}`),
  decide: (companyId: string, caseId: string, body: TriageDecisionBody) =>
    api.post<{ ok: true; decision: TriageDecision; overriddenFields: string[] }>(`/companies/${companyId}/devflow/triage-cases/${caseId}/decision`, body),
};
