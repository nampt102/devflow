import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, GitPullRequestDraft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { DecisionBar } from "../components/review/DecisionBar";
import { ReviewDetailFrame } from "../components/review/ReviewDetailFrame";
import { ReviewWorkspace } from "../components/review/ReviewWorkspace";
import { ApiError } from "../api/client";
import { devflowCodeApi, type CodeDetail, type CodeMetrics, type CodeQueueItem } from "../api/devflowCode";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { CONFIDENCE_LABEL, usd } from "../lib/ba-review";
import { CODE_FAILURE_LABELS, TASK_STATUS_LABELS, codeDecisionBlocker, compareTasks, decisionSummary, readCodeSeenAt, repoOutcome, writeCodeSeenAt } from "../lib/code-review";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { statusLine, type StatusLine } from "../lib/review-workspace";
import { ageLabel, agoLabel, durationLabel } from "../lib/triage-review";

// DevFlow Code review on the shared review workspace: staff read what the Dev agent did (draft pull requests, its report, the
// checks it ran, the approved plan's tasks next to it) and decide. There is nothing to edit here: change the code on GitHub,
// or send it back with a reason and the agent continues on the same branch. DevFlow never merges; approving only lets the
// request go on to QA.

function itemStatus(item: CodeQueueItem): StatusLine {
  const p = item.proposal;
  return statusLine([
    p.blocked.length > 0 ? { tone: "block", icon: "alert-triangle", text: `Not pushed (${p.blocked.map((b) => b.system).join(", ")})` } : null,
    p.checks.failed > 0 ? { tone: "block", icon: "alert-triangle", text: `${p.checks.failed} check${p.checks.failed === 1 ? "" : "s"} failed` } : null,
    p.confidence === "low" ? { tone: "warn", icon: "alert-triangle", text: "Low confidence" } : null,
    p.tasks.done < p.tasks.total ? { tone: "warn", icon: "alert-triangle", text: `${p.tasks.done}/${p.tasks.total} tasks done` } : null,
    p.pullRequests.length > 0 ? { tone: "ok", icon: "check", text: `${p.pullRequests.map((x) => `PR #${x.number}`).join(", ")} · ${p.checks.passed} check${p.checks.passed === 1 ? "" : "s"} passed` } : null,
  ]);
}

export function CodeReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
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

  if (!selectedCompanyId) return <EmptyState icon={GitPullRequestDraft} message="Select an organization to review code." />;
  const companyId = selectedCompanyId;
  return (
    <ReviewWorkspace<CodeQueueItem>
      title="Code review"
      noun="changes"
      emptyIcon={Check}
      emptyHint="A change appears here after the Dev agent has worked on a request whose technical plan was approved. The agent only opens draft pull requests; nothing is merged unless a person merges it on GitHub."
      queueKey={queryKeys.devflowCode.queue(companyId)}
      loadQueue={() => devflowCodeApi.queue(companyId)}
      statusLine={itemStatus}
      subLine={(i) => `${i.proposal.tasks.done}/${i.proposal.tasks.total} tasks · ${CONFIDENCE_LABEL[i.proposal.confidence] ?? i.proposal.confidence}`}
      seenAt={seenAt}
      metrics={<MetricsLoader companyId={companyId} />}
      invalidateOnDecided={async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowCode.queue(companyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowCode.count(companyId) });
      }}
      renderDetail={(item, ctx) => <DetailPanel key={item.caseId} companyId={companyId} caseId={item.caseId} onDecided={ctx.onDecided} />}
    />
  );
}

function DetailPanel({ companyId, caseId, onDecided }: { companyId: string; caseId: string; onDecided: (id: string) => void }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.devflowCode.detail(companyId, caseId),
    queryFn: () => devflowCodeApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  return <Review key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function Review({ companyId, detail, onDecided }: { companyId: string; detail: CodeDetail; onDecided: (id: string) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const decide = useMutation({
    mutationFn: (v: { decision: "approve" | "request_changes" | "reject"; reason: string }) =>
      devflowCodeApi.decide(companyId, detail.caseId, { outputId: detail.outputId, expectedVersion: detail.version, decision: v.decision, reason: v.reason.trim() || undefined }),
    onSuccess: (result) => {
      const s = decisionSummary(detail.caseKey, result);
      pushToast({ title: s.title, body: s.body, tone: s.tone });
      onDecided(detail.caseId);
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
  const report = detail.report;
  const rows = compareTasks(detail.planTasks, report.tasks);
  const failedChecks = report.checks.filter((c) => !c.passed).length;
  const blockedRepos = detail.repos.filter((r) => repoOutcome(r).kind === "blocked").length;
  const openTasks = rows.filter((t) => t.status !== "done").length;

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
      {detail.approveBlocker ? <p className="text-sm text-destructive" role="alert">This work cannot be approved as it is; send it back or reject it.</p> : null}
      <div className="space-y-2 bg-muted/40 p-3">
        <p className="text-xs text-muted-foreground">
          prompt {detail.promptVersion}
          {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[report.confidence] ?? report.confidence}
          {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
        </p>
        <p className="whitespace-pre-wrap text-sm text-foreground">{report.summary}</p>
      </div>
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
      {report.risks.length ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Risks</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {report.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.openQuestions.length ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Open questions</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {report.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );

  const tasks = (
    <div className="space-y-2">
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
    </div>
  );

  const checks = report.checks.length === 0 ? (
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
  );

  return (
    <ReviewDetailFrame
      header={header}
      sections={[
        { id: "summary", label: "Summary", attention: blockedRepos > 0 || !!detail.approveBlocker, content: summary },
        { id: "tasks", label: "Tasks", count: rows.length, attention: openTasks > 0, content: tasks },
        { id: "checks", label: "Checks", count: report.checks.length, attention: failedChecks > 0, content: checks },
      ]}
      bar={
        <DecisionBar
          stage="code"
          pending={decide.isPending}
          notice={noAccess}
          blocker={(decision, reason) => noAccess ?? codeDecisionBlocker(decision, reason, detail.approveBlocker)}
          onDecide={(decision, reason) => decide.mutate({ decision, reason })}
        />
      }
    />
  );
}

function MetricsLoader({ companyId }: { companyId: string }) {
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowCode.metrics(companyId),
    queryFn: () => devflowCodeApi.metrics(companyId, 30),
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

function MetricsBody({ m }: { m: CodeMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  return (
    <div className="space-y-4 p-3">
      <p className="text-xs text-muted-foreground">Last 30 days</p>
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
