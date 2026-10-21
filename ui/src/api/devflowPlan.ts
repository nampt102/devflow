import { api } from "./client";
import type { BaConfidence, BaDecision, BaMetrics } from "./devflowBa";

// Staff review of technical plans (openspec change add-tech-plan-stage).

export type PlanDecision = BaDecision;
export type PlanSize = "S" | "M" | "L";

export interface PlanFile {
  path: string;
  line: number | null;
  change: string;
}

export interface PlanTask {
  id: string;
  title: string;
  system: string | null;
  description: string;
  size: PlanSize;
  files: PlanFile[];
  dependsOn: string[];
}

/** The text fields a reviewer may correct. */
export interface PlanEditable {
  summary: string;
  approach: string;
  dataChanges: string[];
  apiChanges: string[];
  testPlan: string[];
  risks: string[];
  openQuestions: string[];
}

/** What a reviewer may change in a task; its system, files and dependencies stay as the agent wrote them. */
export type PlanTaskEdit = Pick<PlanTask, "id" | "title" | "description" | "size">;

export interface PlanQueueItem {
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
  proposal: { summary: string; confidence: BaConfidence; systems: string[]; tasks: number; sizes: Record<PlanSize, number>; openQuestions: number };
}

export interface PlanDetail {
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
  plan: PlanEditable & { tasks: PlanTask[]; confidence: BaConfidence };
  repos: Array<{ system: string; sha: string; name: string; repoUrl: string | null }>;
  baSpec: { summary: string | null; inScope: string[]; acceptanceCriteria: string[] } | null;
}

export interface PlanDecisionBody {
  outputId: string;
  expectedVersion: number;
  decision: PlanDecision;
  reason?: string;
  final?: Partial<PlanEditable> & { tasks?: PlanTaskEdit[] };
}

export type PlanMetrics = BaMetrics;

export const devflowPlanApi = {
  metrics: (companyId: string, days = 30) => api.get<PlanMetrics>(`/companies/${companyId}/devflow/plan-metrics?days=${days}`),
  count: (companyId: string) => api.get<{ waiting: number; newest: string | null }>(`/companies/${companyId}/devflow/plan-count`),
  queue: (companyId: string) => api.get<{ items: PlanQueueItem[] }>(`/companies/${companyId}/devflow/plan-queue`),
  detail: (companyId: string, caseId: string) => api.get<PlanDetail>(`/companies/${companyId}/devflow/plan-cases/${caseId}`),
  decide: (companyId: string, caseId: string, body: PlanDecisionBody) =>
    api.post<{ ok: true; decision: PlanDecision; overriddenFields: string[] }>(`/companies/${companyId}/devflow/plan-cases/${caseId}/decision`, body),
};
