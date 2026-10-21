import { api } from "./client";

// Staff review of BA specs (openspec change add-ba-spec-stage).

export type BaDecision = "approve" | "reject" | "request_changes";
export type BaConfidence = "low" | "medium" | "high";

export interface BaStory {
  asA: string;
  iWant: string;
  soThat: string;
}

export interface BaArea {
  system: string;
  path: string;
  line: number | null;
  why: string;
}

/** The fields a reviewer may correct. */
export interface BaEditable {
  summary: string;
  businessGoal: string;
  inScope: string[];
  outOfScope: string[];
  userStories: BaStory[];
  acceptanceCriteria: string[];
  dataChanges: string[];
  risks: string[];
  openQuestions: string[];
}

export interface BaQueueItem {
  caseId: string;
  caseKey: string;
  requestNumber: number;
  title: string;
  requesterName: string;
  createdAt: string;
  version: number;
  outputId: string;
  promptVersion: string;
  proposedAt: string;
  proposal: { summary: string; confidence: BaConfidence; systems: string[]; openQuestions: number; acceptanceCriteria: number };
}

export interface BaSystems {
  available: Array<{ id: string; key: string; name: string; description: string }>;
  selectedIds: string[];
}

export interface BaDetail {
  /** false when the viewer lacks the role the stage asks for (add-approver-roles) */
  canDecide: boolean;
  requiredRoles: string[];
  caseId: string;
  caseKey: string;
  requestNumber: number;
  title: string;
  description: string;
  businessImpact: string | null;
  triage: { classification: string | null; priority: string | null; difficulty: string | null };
  requesterName: string;
  createdAt: string;
  version: number;
  attachments: Array<{ id: string; name: string | null; contentType: string | null; size: number | null; contentPath: string }>;
  outputId: string;
  promptVersion: string;
  model: string | null;
  costUsd: number | null;
  spec: BaEditable & { affectedAreas: BaArea[]; confidence: BaConfidence };
  repos: Array<{ system: string; sha: string; name: string; repoUrl: string | null }>;
  systems: BaSystems;
}

export interface BaDecisionBody {
  outputId: string;
  expectedVersion: number;
  decision: BaDecision;
  reason?: string;
  systemIds?: string[];
  final?: Partial<BaEditable>;
}

export interface BaMetrics {
  windowDays: number;
  approved: { total: number; overridden: number; overrideRate: number | null; byPromptVersion: Array<{ promptVersion: string; total: number; overridden: number; overrideRate: number | null }> };
  fields: Array<{ field: string; overrides: number; rate: number | null }>;
  decisions: { approve: number; reject: number; requestChanges: number };
  flow: { secondsInReview: { p50: number | null; p90: number | null } };
  queue: { waiting: number; oldestSince: string | null };
  recentFailures: Array<{ action: string; kind: string | null; caseKey: string | null; at: string }>;
  agent: { proposed: number; failed: number; gaveUp: number; budgetPaused: number; runs: number; failedRuns: number; spendUsd: number; avgUsdPerRun: number | null; inputTokens: number; outputTokens: number };
}

export const devflowBaApi = {
  metrics: (companyId: string, days = 30) => api.get<BaMetrics>(`/companies/${companyId}/devflow/ba-metrics?days=${days}`),
  count: (companyId: string) => api.get<{ waiting: number; newest: string | null }>(`/companies/${companyId}/devflow/ba-count`),
  queue: (companyId: string) => api.get<{ items: BaQueueItem[] }>(`/companies/${companyId}/devflow/ba-queue`),
  detail: (companyId: string, caseId: string) => api.get<BaDetail>(`/companies/${companyId}/devflow/ba-cases/${caseId}`),
  decide: (companyId: string, caseId: string, body: BaDecisionBody) =>
    api.post<{ ok: true; decision: BaDecision; overriddenFields: string[] }>(`/companies/${companyId}/devflow/ba-cases/${caseId}/decision`, body),
};
