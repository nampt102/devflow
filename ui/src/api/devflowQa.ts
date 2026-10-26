import { api } from "./client";
import type { BaConfidence, BaDecision, BaMetrics } from "./devflowBa";
import type { CodeDecisionResult } from "./devflowCode";

// Staff sign-off of the QA agent's report (openspec change add-qa-stage): per-criterion verdicts with evidence, the commands
// it ran, the issues it found, DevFlow's recommendation and its warnings.

export type QaDecision = BaDecision;
export type QaVerdict = "pass" | "fail" | "not_verified";
export type QaHow = "automated" | "code_reading" | "manual";
export type QaSeverity = "high" | "medium" | "low";
export type QaWarning = "qa_modified_branch" | "branch_moved";

export interface QaRecommendation {
  value: "approve" | "changes";
  /** codes such as criteria_failed:AC2, criteria_not_verified:AC3, checks_failed, high_issue, qa_modified_branch */
  reasons: string[];
}

export interface QaQueueItem {
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
    recommendation: "approve" | "changes" | null;
    warnings: QaWarning[];
    systems: string[];
    pullRequests: Array<{ system: string; number: number; url: string }>;
    criteria: { total: number; pass: number; fail: number; notVerified: number };
    checks: { passed: number; failed: number };
    issues: { high: number; total: number };
  };
}

export interface QaDetail {
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
    criteria: Array<{ id: string; verdict: QaVerdict; how: QaHow; evidence: string; text: string }>;
    checks: Array<{ system: string; command: string; passed: boolean; outputTail: string }>;
    issues: Array<{ severity: QaSeverity; title: string; steps: string }>;
    manualTests: string[];
    confidence: BaConfidence;
  };
  recommendation: QaRecommendation;
  warnings: QaWarning[];
  repos: Array<{
    system: string;
    name: string;
    repoUrl: string | null;
    branch: string;
    approvedSha: string | null;
    testedSha: string;
    prUrl: string | null;
    prNumber: number | null;
  }>;
}

export interface QaDecisionBody {
  outputId: string;
  expectedVersion: number;
  decision: QaDecision;
  reason?: string;
}

export interface QaMetrics extends BaMetrics {
  recommendation: { decided: number; approvedAgainst: number; returnedAgainst: number; againstRate: number | null };
}

export const devflowQaApi = {
  metrics: (companyId: string, days = 30) => api.get<QaMetrics>(`/companies/${companyId}/devflow/qa-metrics?days=${days}`),
  count: (companyId: string) => api.get<{ waiting: number; newest: string | null }>(`/companies/${companyId}/devflow/qa-count`),
  queue: (companyId: string) => api.get<{ items: QaQueueItem[] }>(`/companies/${companyId}/devflow/qa-queue`),
  detail: (companyId: string, caseId: string) => api.get<QaDetail>(`/companies/${companyId}/devflow/qa-cases/${caseId}`),
  decide: (companyId: string, caseId: string, body: QaDecisionBody) =>
    api.post<CodeDecisionResult>(`/companies/${companyId}/devflow/qa-cases/${caseId}/decision`, body),
};
