import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, ListChecks, Loader2, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ApiError } from "../api/client";
import { devflowPlanApi, type PlanDecision, type PlanDetail, type PlanMetrics, type PlanSize, type PlanTaskEdit } from "../api/devflowPlan";
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
import { ageLabel, agoLabel, durationLabel, isNewSince, pct } from "../lib/triage-review";

// DevFlow Plan review: staff read the agent's technical plan (tasks by system, with sizes, dependencies and cited
// files), correct its text, and decide. The task list itself is the agent's: to change it, send the plan back.

const SIZES: readonly PlanSize[] = ["S", "M", "L"];

export function PlanReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const queueQuery = useQuery({
    queryKey: queryKeys.devflowPlan.queue(selectedCompanyId ?? "none"),
    queryFn: () => devflowPlanApi.queue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const items = queueQuery.data?.items ?? [];
  const newCount = items.filter((i) => isNewSince(i.proposedAt, seenAt)).length;
  const activeId = selectedId && items.some((i) => i.caseId === selectedId) ? selectedId : (items[0]?.caseId ?? null);

  if (!selectedCompanyId) return <EmptyState icon={ListChecks} message="Select an organization to review technical plans." />;
  if (queueQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Plan review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {items.length} plan{items.length === 1 ? "" : "s"} waiting{newCount > 0 ? ` (${newCount} new since your last visit)` : ""}. The Planner only drafts; your decision moves the request on.
        </p>
      </div>
      {queueQuery.error ? <p className="text-sm text-amber-700 dark:text-amber-300">The queue could not be loaded. Try again in a moment.</p> : null}

      <MetricsPanel companyId={selectedCompanyId} />

      {items.length === 0 ? (
        <EmptyState icon={Check} message="No technical plan is waiting for review." description="A plan appears here after the Planner has read the approved BA spec and the systems assigned to the request." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1" aria-label="Plans waiting for review">
            {items.map((item) => (
              <li key={item.caseId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.caseId)}
                  aria-current={item.caseId === activeId}
                  className={`w-full border p-3 text-left transition-colors hover:bg-accent/50 ${item.caseId === activeId ? "border-primary bg-accent/40" : "border-border"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{item.caseKey}</span>
                      {isNewSince(item.proposedAt, seenAt) ? <Badge>New</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{ageLabel(item.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-foreground">{item.title}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant={item.proposal.confidence === "low" ? "destructive" : "secondary"}>{CONFIDENCE_LABEL[item.proposal.confidence] ?? item.proposal.confidence}</Badge>
                    <Badge variant="outline">
                      {item.proposal.tasks} task{item.proposal.tasks === 1 ? "" : "s"}: {sizeSummary(item.proposal.sizes)}
                    </Badge>
                    {item.proposal.systems.map((s) => (
                      <Badge key={s} variant="outline">{s}</Badge>
                    ))}
                    {item.proposal.openQuestions > 0 ? <Badge variant="outline">{item.proposal.openQuestions} open question{item.proposal.openQuestions === 1 ? "" : "s"}</Badge> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="lg:col-span-2">{activeId ? <DetailPanel key={activeId} companyId={selectedCompanyId} caseId={activeId} onDecided={() => setSelectedId(null)} /> : null}</div>
        </div>
      )}
    </div>
  );
}

function DetailPanel({ companyId, caseId, onDecided }: { companyId: string; caseId: string; onDecided: () => void }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.devflowPlan.detail(companyId, caseId),
    queryFn: () => devflowPlanApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: PlanDetail; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const base = useMemo(() => draftFromPlan(detail.plan), [detail]);
  const [draft, setDraft] = useState<PlanDraft>(base);
  const [reason, setReason] = useState("");
  const changed = changedPlanFields(detail.plan, draft);
  const set = (key: Exclude<keyof PlanDraft, "tasks">, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const setTask = (id: string, patch: Partial<PlanTaskEdit>) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

  const decide = useMutation({
    mutationFn: (decision: PlanDecision) =>
      devflowPlanApi.decide(companyId, detail.caseId, {
        outputId: detail.outputId,
        expectedVersion: detail.version,
        decision,
        reason: reason.trim() || undefined,
        // corrections only count when approving
        ...(decision === "approve" ? { final: planFinalPatch(detail.plan, draft) } : {}),
      }),
    onSuccess: async (result) => {
      pushToast({
        title: `${detail.caseKey} ${result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back"}`,
        body: result.overriddenFields.length ? `Corrected: ${result.overriddenFields.map((f) => PLAN_FIELD_LABELS[f as keyof typeof PLAN_FIELD_LABELS] ?? f).join(", ")}` : undefined,
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowPlan.queue(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowPlan.count(companyId) });
      onDecided();
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
  const blocker = (decision: PlanDecision) => planDecisionBlocker(decision, draft, reason);
  const plan = detail.plan;
  const editOf = (id: string) => draft.tasks.find((t) => t.id === id)!;

  return (
    <div className="space-y-5 border border-border p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">{detail.caseKey}</span>
          <span className="text-xs text-muted-foreground">
            from {detail.requesterName}, {agoLabel(detail.createdAt)}
          </span>
          {[detail.triage.classification, detail.triage.priority, detail.triage.difficulty].filter(Boolean).map((t) => (
            <Badge key={t} variant="outline">{t}</Badge>
          ))}
        </div>
        <h2 className="text-lg font-semibold text-foreground">{detail.title}</h2>
      </header>

      {detail.baSpec ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Approved BA spec</h3>
          {detail.baSpec.summary ? <p className="text-sm text-foreground">{detail.baSpec.summary}</p> : null}
          {detail.baSpec.acceptanceCriteria.length ? (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
              {detail.baSpec.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-3 bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Technical plan (draft by the agent)</h3>
          <span className="text-xs text-muted-foreground">
            prompt {detail.promptVersion}
            {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[plan.confidence] ?? plan.confidence}
            {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
          </span>
        </div>
        <TextBox id="plan-summary" label="Summary" value={draft.summary} rows={3} onChange={(v) => set("summary", v)} edited={changed.includes("summary")} />
        <TextBox id="plan-approach" label="Approach" value={draft.approach} rows={5} onChange={(v) => set("approach", v)} edited={changed.includes("approach")} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Tasks</h3>
          <span className="text-xs text-muted-foreground">
            {detail.repos.length ? detail.repos.map((r) => `${r.name} at commit ${r.sha.slice(0, 8)}`).join("; ") : "No repository was read: the plan comes from the spec alone."}
          </span>
          {changed.includes("tasks") ? <span className="text-xs text-amber-700 dark:text-amber-300">Edited</span> : null}
        </div>
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
      </section>

      <section className="space-y-3 bg-muted/40 p-3">
        <TextBox id="plan-data" label="Data changes (one per line)" value={draft.dataChanges} rows={2} onChange={(v) => set("dataChanges", v)} edited={changed.includes("dataChanges")} />
        <TextBox id="plan-api" label="API changes (one per line)" value={draft.apiChanges} rows={2} onChange={(v) => set("apiChanges", v)} edited={changed.includes("apiChanges")} />
        <TextBox id="plan-tests" label="Test plan (one per line)" value={draft.testPlan} rows={4} onChange={(v) => set("testPlan", v)} edited={changed.includes("testPlan")} />
        <TextBox id="plan-risks" label="Risks (one per line)" value={draft.risks} rows={2} onChange={(v) => set("risks", v)} edited={changed.includes("risks")} />
        <TextBox id="plan-questions" label="Open questions (one per line)" value={draft.openQuestions} rows={3} onChange={(v) => set("openQuestions", v)} edited={changed.includes("openQuestions")} />
      </section>

      <section className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="plan-reason">
          Reason (required to reject or request changes)
        </label>
        <Textarea id="plan-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Tell the agent or the requester what to change" />
        <p className="text-xs text-muted-foreground">With "Request changes" the agent sees your reason on its next pass. Text you edited above is kept only when you approve.</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={decide.isPending || !!blocker("request_changes")} title={blocker("request_changes") ?? undefined} onClick={() => decide.mutate("request_changes")}>
              <RotateCcw className="h-4 w-4" /> Request changes
            </Button>
            <Button type="button" variant="destructive" disabled={decide.isPending || !!blocker("reject")} title={blocker("reject") ?? undefined} onClick={() => decide.mutate("reject")}>
              <X className="h-4 w-4" /> Reject
            </Button>
          </div>
          <Button type="button" disabled={decide.isPending || !!blocker("approve")} title={blocker("approve") ?? undefined} onClick={() => decide.mutate("approve")}>
            {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {changed.length ? `Approve with ${changed.length} correction${changed.length === 1 ? "" : "s"}` : "Approve"}
          </Button>
        </div>
      </section>
    </div>
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

function MetricsPanel({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowPlan.metrics(companyId),
    queryFn: () => devflowPlanApi.metrics(companyId, 30),
    refetchInterval: 60_000,
  });
  const m = metricsQuery.data;
  return (
    <section className="border border-border">
      <button type="button" className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium text-foreground" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Quality and cost, last 30 days
        {m ? (
          <span className="font-normal text-muted-foreground">
            {m.approved.total === 0 ? "no approved plans yet" : `${pct(m.approved.overrideRate)} of ${m.approved.total} approved plans were corrected`}; {usd(m.agent.spendUsd)} spent
          </span>
        ) : null}
      </button>
      {open ? (m ? <MetricsBody m={m} /> : <p className="p-3 text-sm text-muted-foreground">{metricsQuery.isLoading ? "Loading..." : "Metrics are not available right now."}</p>) : null}
    </section>
  );
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
    <div className="space-y-4 border-t border-border p-3">
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
