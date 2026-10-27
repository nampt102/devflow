import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { DecisionBar } from "../components/review/DecisionBar";
import { ReviewDetailFrame } from "../components/review/ReviewDetailFrame";
import { ReviewWorkspace } from "../components/review/ReviewWorkspace";
import { ApiError } from "../api/client";
import { devflowPlanApi, type PlanDecision, type PlanDetail, type PlanMetrics, type PlanQueueItem, type PlanSize, type PlanTaskEdit } from "../api/devflowPlan";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { CONFIDENCE_LABEL, usd } from "../lib/ba-review";
import {
  changedPlanFields,
  draftFromPlan,
  PLAN_FAILURE_LABELS,
  PLAN_FIELD_LABELS,
  planDecisionBlocker,
  planFileLabel,
  planFileUrl,
  planFinalPatch,
  readPlanSeenAt,
  SIZE_LABELS,
  sizeSummary,
  tasksBySystem,
  writePlanSeenAt,
  type PlanDraft,
} from "../lib/plan-review";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { statusLine, type StatusLine } from "../lib/review-workspace";
import { ageLabel, agoLabel, durationLabel, pct } from "../lib/triage-review";

// DevFlow Plan review on the shared review workspace: staff read the agent's technical plan (tasks by system, with sizes,
// dependencies and cited files), correct its text, and decide. The task list itself is the agent's: to change it, send the
// plan back.

const SIZES: readonly PlanSize[] = ["S", "M", "L"];

function itemStatus(item: PlanQueueItem): StatusLine {
  const p = item.proposal;
  return statusLine([
    p.confidence === "low" ? { tone: "warn", icon: "alert-triangle", text: "Low confidence" } : null,
    p.openQuestions > 0 ? { tone: "warn", icon: "alert-triangle", text: `${p.openQuestions} open question${p.openQuestions === 1 ? "" : "s"}` } : null,
    { tone: "ok", icon: "check", text: `${p.tasks} task${p.tasks === 1 ? "" : "s"}: ${sizeSummary(p.sizes)}` },
  ]);
}

export function PlanReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  // When the reviewer last left this page: anything that arrived since carries a "New" label.
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    if (!selectedCompanyId) return;
    setSeenAt(readPlanSeenAt(selectedCompanyId));
    const mark = () => writePlanSeenAt(selectedCompanyId);
    window.addEventListener("pagehide", mark);
    return () => {
      mark();
      window.removeEventListener("pagehide", mark);
    };
  }, [selectedCompanyId]);
  useEffect(() => {
    setBreadcrumbs([{ label: "Plan review" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={ListChecks} message="Select an organization to review technical plans." />;
  const companyId = selectedCompanyId;
  return (
    <ReviewWorkspace<PlanQueueItem>
      title="Plan review"
      noun="plans"
      emptyIcon={Check}
      emptyHint="A plan appears here after the Planner has read the approved BA spec and the systems assigned to the request. The Planner only drafts; your decision moves the request on."
      queueKey={queryKeys.devflowPlan.queue(companyId)}
      loadQueue={() => devflowPlanApi.queue(companyId)}
      statusLine={itemStatus}
      subLine={(i) => (i.proposal.systems.length ? i.proposal.systems.join(", ") : null)}
      seenAt={seenAt}
      metrics={<MetricsLoader companyId={companyId} />}
      invalidateOnDecided={async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowPlan.queue(companyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowPlan.count(companyId) });
      }}
      renderDetail={(item, ctx) => <DetailPanel key={item.caseId} companyId={companyId} caseId={item.caseId} onDecided={ctx.onDecided} />}
    />
  );
}

function DetailPanel({ companyId, caseId, onDecided }: { companyId: string; caseId: string; onDecided: (id: string) => void }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.devflowPlan.detail(companyId, caseId),
    queryFn: () => devflowPlanApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: PlanDetail; onDecided: (id: string) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const base = useMemo(() => draftFromPlan(detail.plan), [detail]);
  const [draft, setDraft] = useState<PlanDraft>(base);
  const changed = changedPlanFields(detail.plan, draft);
  const set = (key: Exclude<keyof PlanDraft, "tasks">, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const setTask = (id: string, patch: Partial<PlanTaskEdit>) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

  const decide = useMutation({
    mutationFn: (v: { decision: PlanDecision; reason: string }) =>
      devflowPlanApi.decide(companyId, detail.caseId, {
        outputId: detail.outputId,
        expectedVersion: detail.version,
        decision: v.decision,
        reason: v.reason.trim() || undefined,
        // corrections only count when approving
        ...(v.decision === "approve" ? { final: planFinalPatch(detail.plan, draft) } : {}),
      }),
    onSuccess: (result) => {
      pushToast({
        title: `${detail.caseKey} ${result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back"}`,
        body: result.overriddenFields.length ? `Corrected: ${result.overriddenFields.map((f) => PLAN_FIELD_LABELS[f as keyof typeof PLAN_FIELD_LABELS] ?? f).join(", ")}` : undefined,
        tone: "success",
      });
      onDecided(detail.caseId);
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      pushToast({
        title: conflict ? "Already handled" : "Decision not saved",
        body: conflict ? "Someone else decided this request or the plan changed. The queue was refreshed." : error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowPlan.queue(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowPlan.detail(companyId, detail.caseId) });
    },
  });
  const noAccess = accessBlocker(detail);
  const plan = detail.plan;
  const editOf = (id: string) => draft.tasks.find((t) => t.id === id)!;

  const header = (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{detail.caseKey}</span> · from {detail.requesterName}, {agoLabel(detail.createdAt)}
        {[detail.triage.classification, detail.triage.priority, detail.triage.difficulty].filter(Boolean).map((t) => ` · ${t}`)}
      </p>
      <h2 className="text-base font-semibold text-foreground">{detail.title}</h2>
    </div>
  );

  const summary = (
    <div className="space-y-3">
      {detail.baSpec ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Approved BA spec</p>
          {detail.baSpec.summary ? <p className="text-sm text-foreground">{detail.baSpec.summary}</p> : null}
          {detail.baSpec.acceptanceCriteria.length ? (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
              {detail.baSpec.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-3 bg-muted/40 p-3">
        <p className="text-xs text-muted-foreground">
          Draft by the agent: prompt {detail.promptVersion}
          {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[plan.confidence] ?? plan.confidence}
          {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
        </p>
        <TextBox id="plan-summary" label="Summary" value={draft.summary} rows={3} onChange={(v) => set("summary", v)} edited={changed.includes("summary")} />
        <TextBox id="plan-approach" label="Approach" value={draft.approach} rows={5} onChange={(v) => set("approach", v)} edited={changed.includes("approach")} />
      </div>
    </div>
  );

  const tasks = (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {detail.repos.length ? detail.repos.map((r) => `${r.name} at commit ${r.sha.slice(0, 8)}`).join("; ") : "No repository was read: the plan comes from the spec alone."}
        {changed.includes("tasks") ? <span className="ml-2 text-amber-700 dark:text-amber-300">Edited</span> : null}
      </p>
      {tasksBySystem(plan.tasks).map((group) => (
        <div key={group.system ?? "none"} className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{group.system ? (detail.repos.find((r) => r.system === group.system)?.name ?? group.system) : "No system"}</p>
          <ul className="space-y-2">
            {group.tasks.map((t) => {
              const edit = editOf(t.id);
              return (
                <li key={t.id} className="space-y-2 border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
                    <Input aria-label={`Title of ${t.id}`} value={edit.title} onChange={(e) => setTask(t.id, { title: e.target.value })} className="min-w-0 flex-1" />
                    <div className="flex gap-1" role="group" aria-label={`Size of ${t.id}`}>
                      {SIZES.map((s) => (
                        <Button key={s} type="button" size="sm" variant={edit.size === s ? "default" : "outline"} title={SIZE_LABELS[s]} aria-pressed={edit.size === s} onClick={() => setTask(t.id, { size: s })}>
                          {s}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {t.dependsOn.length ? <p className="text-xs text-muted-foreground">After {t.dependsOn.join(", ")}</p> : null}
                  <Textarea aria-label={`Description of ${t.id}`} value={edit.description} rows={2} onChange={(e) => setTask(t.id, { description: e.target.value })} />
                  {t.files.length ? (
                    <ul className="space-y-1">
                      {t.files.map((f, i) => {
                        const url = planFileUrl(detail.repos, t.system, f);
                        return (
                          <li key={i} className="text-sm">
                            {url ? (
                              <a className="inline-flex items-center gap-1 font-mono text-xs text-primary underline-offset-4 hover:underline" href={url} target="_blank" rel="noreferrer noopener">
                                {planFileLabel(f)} <ExternalLink className="h-3 w-3" aria-hidden />
                              </a>
                            ) : (
                              <span className="font-mono text-xs text-foreground">{planFileLabel(f)}</span>
                            )}
                            <span className="text-muted-foreground"> {f.change}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">You can change a task's title, description and size. To add, remove or split tasks, or change their files or order, send the plan back.</p>
    </div>
  );

  const notes = (
    <div className="space-y-3 bg-muted/40 p-3">
      <TextBox id="plan-data" label="Data changes (one per line)" value={draft.dataChanges} rows={2} onChange={(v) => set("dataChanges", v)} edited={changed.includes("dataChanges")} />
      <TextBox id="plan-api" label="API changes (one per line)" value={draft.apiChanges} rows={2} onChange={(v) => set("apiChanges", v)} edited={changed.includes("apiChanges")} />
      <TextBox id="plan-tests" label="Test plan (one per line)" value={draft.testPlan} rows={4} onChange={(v) => set("testPlan", v)} edited={changed.includes("testPlan")} />
      <TextBox id="plan-risks" label="Risks (one per line)" value={draft.risks} rows={2} onChange={(v) => set("risks", v)} edited={changed.includes("risks")} />
      <TextBox id="plan-questions" label="Open questions (one per line)" value={draft.openQuestions} rows={3} onChange={(v) => set("openQuestions", v)} edited={changed.includes("openQuestions")} />
    </div>
  );

  const notesEdited = ["dataChanges", "apiChanges", "testPlan", "risks", "openQuestions"].some((f) => changed.includes(f as never));
  return (
    <ReviewDetailFrame
      header={header}
      sections={[
        { id: "summary", label: "Summary", content: summary },
        { id: "tasks", label: "Tasks", count: plan.tasks.length, content: tasks },
        { id: "notes", label: notesEdited ? "Notes (edited)" : "Notes", content: notes },
      ]}
      bar={
        <DecisionBar
          stage="plan"
          pending={decide.isPending}
          notice={noAccess ?? (changed.length ? "Text you edited is kept only when you approve." : null)}
          approveLabel={changed.length ? `Approve with ${changed.length} correction${changed.length === 1 ? "" : "s"}` : undefined}
          blocker={(decision, reason) => noAccess ?? planDecisionBlocker(decision, draft, reason)}
          onDecide={(decision, reason) => decide.mutate({ decision, reason })}
        />
      }
    />
  );
}

function TextBox({ id, label, value, rows, onChange, edited }: { id: string; label: string; value: string; rows: number; onChange: (v: string) => void; edited: boolean }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground" htmlFor={id}>
        {label}
        {edited ? <span className="ml-2 text-amber-700 dark:text-amber-300">Edited</span> : null}
      </label>
      <Textarea id={id} value={value} rows={rows} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function MetricsLoader({ companyId }: { companyId: string }) {
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowPlan.metrics(companyId),
    queryFn: () => devflowPlanApi.metrics(companyId, 30),
    refetchInterval: 60_000,
  });
  const m = metricsQuery.data;
  if (!m) return <p className="p-3 text-sm text-muted-foreground">{metricsQuery.isLoading ? "Loading..." : "Metrics are not available right now."}</p>;
  return <MetricsBody m={m} />;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function MetricsBody({ m }: { m: PlanMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  return (
    <div className="space-y-4 p-3">
      <p className="text-xs text-muted-foreground">Last 30 days</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Waiting" value={String(m.queue.waiting)} hint={m.queue.oldestSince ? `oldest ${ageLabel(m.queue.oldestSince)}` : undefined} />
        <Stat label="Corrected" value={pct(m.approved.overrideRate)} hint={`${m.approved.overridden} of ${m.approved.total} approved`} />
        <Stat label="Time in review" value={durationLabel(m.flow.secondsInReview.p50)} hint={`p90 ${durationLabel(m.flow.secondsInReview.p90)}`} />
        <Stat label="Decisions" value={String(decided)} hint={`${m.decisions.approve} approved, ${m.decisions.reject} rejected, ${m.decisions.requestChanges} sent back`} />
        <Stat label="Spent" value={usd(m.agent.spendUsd)} hint={`${m.agent.runs} runs, ${usd(m.agent.avgUsdPerRun)} each`} />
        <Stat label="Agent problems" value={String(m.agent.failed + m.agent.gaveUp)} hint={`${m.agent.failedRuns} failed runs, ${m.agent.gaveUp} given up`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Share of approved plans corrected, by field</p>
          {m.fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">No corrections yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {m.fields.map((f) => (
                  <tr key={f.field} className="border-b border-border last:border-0">
                    <td className="py-1 text-foreground">{PLAN_FIELD_LABELS[f.field as keyof typeof PLAN_FIELD_LABELS] ?? f.field}</td>
                    <td className="py-1 text-right text-foreground">{pct(f.rate)}</td>
                    <td className="py-1 text-right text-muted-foreground">{f.overrides}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {m.approved.byPromptVersion.length ? (
            <p className="mt-2 text-xs text-muted-foreground">By prompt: {m.approved.byPromptVersion.map((v) => `${v.promptVersion} ${pct(v.overrideRate)} of ${v.total}`).join(", ")}</p>
          ) : null}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Recent problems</p>
          {m.recentFailures.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-1 text-sm text-foreground">
              {m.recentFailures.map((f, i) => (
                <li key={i}>
                  {f.caseKey ? <span className="font-mono text-xs text-muted-foreground">{f.caseKey} </span> : null}
                  {PLAN_FAILURE_LABELS[f.action] ?? f.action}
                  {f.kind ? `: ${f.kind}` : ""} <span className="text-muted-foreground">{agoLabel(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
