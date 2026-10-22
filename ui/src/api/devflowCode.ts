import { api } from "./client";
import type { BaConfidence, BaDecision, BaMetrics } from "./devflowBa";

// Staff review of the Dev agent's work (openspec change add-dev-stage): draft pull requests, the agent's report and checks.

export type CodeDecision = BaDecision;
export type CodeTaskStatus = "done" | "partial" | "skipped";

/** What DevFlow found for one system: a draft pull request, no commit, or a diff it refused to push. */
export interface CodeRepo {
  system: string;
  name: string;
  repoUrl: string | null;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha?: string;
  commits?: number;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  prUrl?: string;
  prNumber?: number;
  newPr?: boolean;
  unprotectedWarning?: boolean;
  noChanges?: true;
  blocked?: { kind: string; paths: string[] };
}

export interface CodeQueueItem {
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
  proposal: {
    summary: string;
    confidence: BaConfidence;
    systems: string[];
    pullRequests: Array<{ system: string; number: number; url: string }>;
    blocked: Array<{ system: string; kind: string }>;
    noChanges: string[];
    tasks: { total: number; done: number; partial: number; skipped: number };
    checks: { passed: number; failed: number };
    approvable: boolean;
  };
}

export type ApproveBlocker = "no_pull_request" | "blocked_diff" | null;

export interface CodeDetail {
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
  outputId: string;
  promptVersion: string;
  model: string | null;
  costUsd: number | null;
  report: {
    summary: string;
    tasks: Array<{ id: string; status: CodeTaskStatus; notes: string }>;
    checks: Array<{ system: string; command: string; passed: boolean; outputTail: string }>;
    risks: string[];
    openQuestions: string[];
    confidence: BaConfidence;
  };
  repos: CodeRepo[];
  approveBlocker: ApproveBlocker;
  planTasks: Array<{ id: string; title: string; system: string | null; size: string }>;
  baSpec: { summary: string | null; acceptanceCriteria: string[] } | null;
}

export interface CodeDecisionBody {
  outputId: string;
  expectedVersion: number;
  decision: CodeDecision;
  reason?: string;
}

export interface CodeDecisionResult {
  ok: true;
  decision: CodeDecision;
  closedPullRequests: Array<{ system: string; prNumber: number; closed: boolean }>;
}

export type CodeMetrics = BaMetrics;

export const devflowCodeApi = {
  metrics: (companyId: string, days = 30) => api.get<CodeMetrics>(`/companies/${companyId}/devflow/code-metrics?days=${days}`),
  count: (companyId: string) => api.get<{ waiting: number; newest: string | null }>(`/companies/${companyId}/devflow/code-count`),
  queue: (companyId: string) => api.get<{ items: CodeQueueItem[] }>(`/companies/${companyId}/devflow/code-queue`),
  detail: (companyId: string, caseId: string) => api.get<CodeDetail>(`/companies/${companyId}/devflow/code-cases/${caseId}`),
  decide: (companyId: string, caseId: string, body: CodeDecisionBody) =>
    api.post<CodeDecisionResult>(`/companies/${companyId}/devflow/code-cases/${caseId}/decision`, body),
};
