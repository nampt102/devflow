import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, GitPullRequestDraft, Loader2, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ApiError } from "../api/client";
import { devflowCodeApi, type CodeDecision, type CodeDetail, type CodeMetrics } from "../api/devflowCode";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { CONFIDENCE_LABEL, usd } from "../lib/ba-review";
import { CODE_FAILURE_LABELS, TASK_STATUS_LABELS, codeDecisionBlocker, compareTasks, decisionSummary, readCodeSeenAt, repoOutcome, writeCodeSeenAt } from "../lib/code-review";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { ageLabel, agoLabel, durationLabel, isNewSince } from "../lib/triage-review";

// DevFlow Code review: staff read what the Dev agent did (draft pull requests, its report, the checks it ran, the approved
// plan's tasks next to it) and decide. There is nothing to edit here: change the code on GitHub, or send it back with a
// reason and the agent continues on the same branch. DevFlow never merges; approving only lets the request go on to QA.

export function CodeReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // When the reviewer last left this page: anything that arrived since carries a "New" label.
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    if (!selectedCompanyId) return;
    setSeenAt(readCodeSeenAt(selectedCompanyId));
    const mark = () => writeCodeSeenAt(selectedCompanyId);
    window.addEventListener("pagehide", mark);
    return () => {
      mark();
      window.removeEventListener("pagehide", mark);
    };
  }, [selectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Code review" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const queueQuery = useQuery({
    queryKey: queryKeys.devflowCode.queue(selectedCompanyId ?? "none"),
    queryFn: () => devflowCodeApi.queue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const items = queueQuery.data?.items ?? [];
  const newCount = items.filter((i) => isNewSince(i.proposedAt, seenAt)).length;
  const activeId = selectedId && items.some((i) => i.caseId === selectedId) ? selectedId : (items[0]?.caseId ?? null);

  if (!selectedCompanyId) return <EmptyState icon={GitPullRequestDraft} message="Select an organization to review code." />;
  if (queueQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Code review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {items.length} change{items.length === 1 ? "" : "s"} waiting{newCount > 0 ? ` (${newCount} new since your last visit)` : ""}. The Dev agent only opens draft pull requests; nothing is merged unless a person merges it on GitHub.
        </p>
      </div>
      {queueQuery.error ? <p className="text-sm text-amber-700 dark:text-amber-300">The queue could not be loaded. Try again in a moment.</p> : null}

      <MetricsPanel companyId={selectedCompanyId} />

      {items.length === 0 ? (
        <EmptyState icon={Check} message="No code is waiting for review." description="A change appears here after the Dev agent has worked on a request whose technical plan was approved." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1" aria-label="Code waiting for review">
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
                    {item.proposal.pullRequests.map((p) => (
                      <Badge key={p.url} variant="secondary">PR #{p.number} ({p.system})</Badge>
                    ))}
                    {item.proposal.blocked.map((b) => (
                      <Badge key={b.system} variant="destructive">Not pushed ({b.system})</Badge>
                    ))}
                    {item.proposal.noChanges.map((s) => (
                      <Badge key={s} variant="outline">No change ({s})</Badge>
                    ))}
                    <Badge variant="outline">
                      {item.proposal.tasks.done}/{item.proposal.tasks.total} tasks
                    </Badge>
                    {item.proposal.checks.failed > 0 ? <Badge variant="destructive">{item.proposal.checks.failed} check{item.proposal.checks.failed === 1 ? "" : "s"} failed</Badge> : item.proposal.checks.passed > 0 ? <Badge variant="outline">{item.proposal.checks.passed} check{item.proposal.checks.passed === 1 ? "" : "s"} passed</Badge> : null}
                    <Badge variant={item.proposal.confidence === "low" ? "destructive" : "secondary"}>{CONFIDENCE_LABEL[item.proposal.confidence] ?? item.proposal.confidence}</Badge>
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
    queryKey: queryKeys.devflowCode.detail(companyId, caseId),
    queryFn: () => devflowCodeApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: CodeDetail; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [reason, setReason] = useState("");

  const decide = useMutation({
    mutationFn: (decision: CodeDecision) =>
      devflowCodeApi.decide(companyId, detail.caseId, { outputId: detail.outputId, expectedVersion: detail.version, decision, reason: reason.trim() || undefined }),
    onSuccess: async (result) => {
      const s = decisionSummary(detail.caseKey, result);
      pushToast({ title: s.title, body: s.body, tone: s.tone });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowCode.queue(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowCode.count(companyId) });
      onDecided();
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      pushToast({
        title: conflict ? "Already handled" : "Decision not saved",
        body: conflict ? "Someone else decided this request or the work changed. The queue was refreshed." : error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowCode.queue(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowCode.detail(companyId, detail.caseId) });
    },
  });
  const noAccess = accessBlocker(detail);
  const blocker = (decision: CodeDecision) => noAccess ?? codeDecisionBlocker(decision, reason, detail.approveBlocker);
  const report = detail.report;
  const rows = compareTasks(detail.planTasks, report.tasks);

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
        {noAccess ? <p className="text-sm text-amber-700 dark:text-amber-300" role="status">{noAccess}</p> : null}
      </header>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Pull requests</h3>
        <ul className="space-y-2">
          {detail.repos.map((r) => {
            const o = repoOutcome(r);
            return (
              <li key={r.system} className="border border-border p-3 text-sm">
                <p className="font-medium text-foreground">
                  {r.name} <span className="font-mono text-xs font-normal text-muted-foreground">{r.branch} → {r.baseBranch}</span>
                </p>
                {o.kind === "pull_request" ? (
                  <p className="mt-1 text-foreground">
                    {o.url ? (
                      <a className="inline-flex items-center gap-1 underline underline-offset-2" href={o.url} target="_blank" rel="noreferrer noopener">
                        Draft pull request #{o.number} <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : (
                      <span>Draft pull request #{o.number}</span>
                    )}
                    <span className="ml-2 text-muted-foreground">{o.stats}</span>
                    {o.warning ? <span className="ml-2 text-amber-700 dark:text-amber-300">The default branch of this repository is not protected.</span> : null}
                  </p>
                ) : o.kind === "blocked" ? (
                  <div className="mt-1 space-y-1">
                    <p className="text-destructive" role="alert">Not pushed to GitHub: {o.label}.</p>
                    {o.paths.length ? <p className="break-all font-mono text-xs text-muted-foreground">{o.paths.join(", ")}</p> : null}
                  </div>
                ) : (
                  <p className="mt-1 text-muted-foreground">The agent made no commit, so there is no pull request.</p>
                )}
              </li>
            );
          })}
        </ul>
        {detail.approveBlocker ? <p className="text-xs text-muted-foreground">This work cannot be approved as it is; send it back or reject it.</p> : null}
      </section>

      <section className="space-y-2 bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">What the agent says it did</h3>
          <span className="text-xs text-muted-foreground">
            prompt {detail.promptVersion}
            {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[report.confidence] ?? report.confidence}
            {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-foreground">{report.summary}</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Tasks of the approved plan</h3>
        <ul className="space-y-1.5">
          {rows.map((t) => (
            <li key={t.id} className="text-sm">
              <span className="font-mono text-xs text-muted-foreground">{t.id}</span> <span className="text-foreground">{t.title}</span>{" "}
              <Badge variant={t.status === "done" ? "secondary" : t.status === "not_reported" ? "destructive" : "outline"}>{t.status === "not_reported" ? "Not reported" : TASK_STATUS_LABELS[t.status]}</Badge>
              {t.notes ? <p className="pl-6 text-xs text-muted-foreground">{t.notes}</p> : null}
            </li>
          ))}
        </ul>
        {detail.baSpec?.acceptanceCriteria.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Acceptance criteria of the approved BA spec</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {detail.baSpec.acceptanceCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Checks the agent ran</h3>
        {report.checks.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">The agent ran no check. Run the tests yourself before approving.</p>
        ) : (
          <ul className="space-y-2">
            {report.checks.map((c, i) => (
              <li key={i} className="text-sm">
                <p className="text-foreground">
                  <Badge variant={c.passed ? "secondary" : "destructive"}>{c.passed ? "Passed" : "Failed"}</Badge> <span className="font-mono text-xs">{c.command}</span>{" "}
                  <span className="text-xs text-muted-foreground">({c.system})</span>
                </p>
                {c.outputTail ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap bg-muted/40 p-2 font-mono text-xs text-muted-foreground">{c.outputTail}</pre> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {report.risks.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Risks</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {report.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.openQuestions.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Open questions</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {report.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2 border-t border-border pt-4">
        <label className="text-sm font-medium text-foreground" htmlFor="code-reason">
          Reason (required to reject or request changes)
        </label>
        <Textarea id="code-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Tell the agent or the requester what to change" />
        <p className="text-xs text-muted-foreground">
          "Request changes" keeps the pull request open: the agent sees your reason and continues on the same branch. "Reject" closes the pull request (the branch stays) and cancels the request. Approving does not merge anything.
        </p>
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
            {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
          </Button>
        </div>
      </section>
    </div>
  );
}

function MetricsPanel({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowCode.metrics(companyId),
    queryFn: () => devflowCodeApi.metrics(companyId, 30),
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
            {m.decisions.approve + m.decisions.reject + m.decisions.requestChanges === 0 ? "no decisions yet" : `${m.decisions.approve} approved, ${m.decisions.requestChanges} sent back, ${m.decisions.reject} rejected`}; {usd(m.agent.spendUsd)} spent
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

function MetricsBody({ m }: { m: CodeMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  return (
    <div className="space-y-4 border-t border-border p-3">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Waiting" value={String(m.queue.waiting)} hint={m.queue.oldestSince ? `oldest ${ageLabel(m.queue.oldestSince)}` : undefined} />
        <Stat label="Time in review" value={durationLabel(m.flow.secondsInReview.p50)} hint={`p90 ${durationLabel(m.flow.secondsInReview.p90)}`} />
        <Stat label="Decisions" value={String(decided)} hint={`${m.decisions.approve} approved, ${m.decisions.reject} rejected, ${m.decisions.requestChanges} sent back`} />
        <Stat label="Spent" value={usd(m.agent.spendUsd)} hint={`${m.agent.runs} runs, ${usd(m.agent.avgUsdPerRun)} each`} />
        <Stat label="Agent problems" value={String(m.agent.failed + m.agent.gaveUp)} hint={`${m.agent.failedRuns} failed runs, ${m.agent.gaveUp} given up`} />
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
                {CODE_FAILURE_LABELS[f.action] ?? f.action}
                {f.kind ? `: ${f.kind}` : ""} <span className="text-muted-foreground">{agoLabel(f.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
