import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ClipboardCheck, ExternalLink } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { DecisionBar } from "../components/review/DecisionBar";
import { ReviewDetailFrame } from "../components/review/ReviewDetailFrame";
import { ReviewWorkspace } from "../components/review/ReviewWorkspace";
import { ApiError } from "../api/client";
import { devflowQaApi, type QaDetail, type QaMetrics, type QaQueueItem } from "../api/devflowQa";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { CONFIDENCE_LABEL, usd } from "../lib/ba-review";
import { decisionSummary, safeGithubUrl } from "../lib/code-review";
import { QA_FAILURE_LABELS, SEVERITY_LABELS, VERDICT_LABELS, HOW_LABELS, WARNING_LABELS, againstRateText, criteriaSummary, qaDecisionBlocker, readQaSeenAt, reasonLabel, recommendationText, writeQaSeenAt } from "../lib/qa-review";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { statusLine, type StatusLine } from "../lib/review-workspace";
import { agoLabel, durationLabel } from "../lib/triage-review";

// DevFlow QA sign-off on the shared review workspace: staff read the QA agent's report (each acceptance criterion with its
// verdict and evidence, the commands it ran, the issues it found, what a person still has to check) beside DevFlow's own
// recommendation, and decide. The recommendation is advice: approving is always possible. Approving finishes the request.

function itemStatus(item: QaQueueItem): StatusLine {
  const p = item.proposal;
  return statusLine([
    p.checks.failed > 0 ? { tone: "block", icon: "alert-triangle", text: `${p.checks.failed} command${p.checks.failed === 1 ? "" : "s"} failed` } : null,
    p.issues.high > 0 ? { tone: "block", icon: "alert-triangle", text: `${p.issues.high} high issue${p.issues.high === 1 ? "" : "s"}` } : null,
    p.warnings.length > 0 ? { tone: "warn", icon: "alert-triangle", text: "Branch warning" } : null,
    p.recommendation === "changes" ? { tone: "warn", icon: "rotate", text: "Changes recommended" } : null,
    p.recommendation === "approve" ? { tone: "ok", icon: "check", text: "Approval recommended" } : null,
  ]);
}

export function QaSignoff() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  // When the reviewer last left this page: anything that arrived since carries a "New" label.
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    if (!selectedCompanyId) return;
    setSeenAt(readQaSeenAt(selectedCompanyId));
    const mark = () => writeQaSeenAt(selectedCompanyId);
    window.addEventListener("pagehide", mark);
    return () => {
      mark();
      window.removeEventListener("pagehide", mark);
    };
  }, [selectedCompanyId]);
  useEffect(() => {
    setBreadcrumbs([{ label: "QA sign-off" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={ClipboardCheck} message="Select an organization to sign off QA." />;
  const companyId = selectedCompanyId;
  return (
    <ReviewWorkspace<QaQueueItem>
      title="QA sign-off"
      noun="QA reports"
      emptyIcon={Check}
      emptyHint="A report appears here after the QA agent has checked the pull request of a request whose code was approved."
      queueKey={queryKeys.devflowQa.queue(companyId)}
      loadQueue={() => devflowQaApi.queue(companyId)}
      statusLine={itemStatus}
      subLine={(i) => criteriaSummary(i.proposal.criteria)}
      seenAt={seenAt}
      metrics={<MetricsLoader companyId={companyId} />}
      invalidateOnDecided={async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowQa.queue(companyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowQa.count(companyId) });
      }}
      renderDetail={(item, ctx) => <DetailPanel key={item.caseId} companyId={companyId} caseId={item.caseId} onDecided={ctx.onDecided} />}
    />
  );
}

function DetailPanel({ companyId, caseId, onDecided }: { companyId: string; caseId: string; onDecided: (id: string) => void }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.devflowQa.detail(companyId, caseId),
    queryFn: () => devflowQaApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for sign-off." />;
  return <Review key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function Review({ companyId, detail, onDecided }: { companyId: string; detail: QaDetail; onDecided: (id: string) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const decide = useMutation({
    mutationFn: (v: { decision: "approve" | "request_changes" | "reject"; reason: string }) =>
      devflowQaApi.decide(companyId, detail.caseId, { outputId: detail.outputId, expectedVersion: detail.version, decision: v.decision, reason: v.reason.trim() || undefined }),
    onSuccess: (result) => {
      const s = decisionSummary(detail.caseKey, result);
      pushToast({ title: s.title, body: s.body, tone: s.tone });
      onDecided(detail.caseId);
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      pushToast({
        title: conflict ? "Already handled" : "Decision not saved",
        body: conflict ? "Someone else decided this request or the report changed. The queue was refreshed." : error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowQa.queue(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowQa.detail(companyId, detail.caseId) });
    },
  });
  const noAccess = accessBlocker(detail);
  const report = detail.report;
  const rec = detail.recommendation;
  const failedChecks = report.checks.filter((c) => !c.passed).length;
  const highIssues = report.issues.filter((i) => i.severity === "high").length;
  const openCriteria = report.criteria.filter((c) => c.verdict !== "pass").length;

  const header = (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{detail.caseKey}</span> · from {detail.requesterName}, {agoLabel(detail.createdAt)}
        {" · "}
        <Link to={`/requests/${detail.caseKey}`} className="underline underline-offset-2">History</Link>
        {[detail.triage.classification, detail.triage.priority, detail.triage.difficulty].filter(Boolean).map((t) => ` · ${t}`)}
      </p>
      <h2 className="text-base font-semibold text-foreground">{detail.title}</h2>
    </div>
  );

  const summary = (
    <div className="space-y-3">
      <div className={`space-y-1 p-3 ${rec.value === "approve" ? "bg-muted/40" : "bg-amber-50 dark:bg-amber-950/30"}`}>
        <p className="text-sm font-medium text-foreground">{recommendationText(rec.value)}</p>
        {rec.reasons.length ? (
          <ul className="list-disc pl-5 text-sm text-foreground">
            {rec.reasons.map((r) => (
              <li key={r}>{reasonLabel(r)}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">DevFlow's own reading of the report. You decide.</p>
      </div>
      <p className="whitespace-pre-wrap text-sm text-foreground">{report.summary}</p>
      {detail.warnings.map((w) => (
        <p key={w} className="text-sm text-amber-700 dark:text-amber-300" role="alert">{WARNING_LABELS[w] ?? w}</p>
      ))}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Criteria" value={`${report.criteria.length - openCriteria} of ${report.criteria.length} pass`} />
        <Stat label="Commands" value={report.checks.length ? `${report.checks.length - failedChecks} of ${report.checks.length} passed` : "none run"} />
        <Stat label="Confidence" value={CONFIDENCE_LABEL[report.confidence] ?? report.confidence} />
        <Stat label="Cost" value={detail.costUsd !== null ? `${detail.costUsd.toFixed(2)} USD` : "n/a"} mono />
      </div>
      <ul className="space-y-1 text-sm">
        {detail.repos.map((r) => {
          const url = safeGithubUrl(r.prUrl);
          return (
            <li key={r.system} className="text-foreground">
              {r.name} <span className="font-mono text-xs text-muted-foreground">{r.branch}</span>{" "}
              {url ? (
                <a className="inline-flex items-center gap-1 underline underline-offset-2" href={url} target="_blank" rel="noreferrer noopener">
                  PR #{r.prNumber} <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ) : null}
              <span className="ml-2 text-xs text-muted-foreground">checked {r.testedSha.slice(0, 8)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const criteria = (
    <ul className="space-y-2">
      {report.criteria.map((c) => (
        <li key={c.id} className="border border-border p-2 text-sm">
          <p className="text-foreground">
            <Badge variant={c.verdict === "pass" ? "secondary" : c.verdict === "fail" ? "destructive" : "outline"}>{VERDICT_LABELS[c.verdict]}</Badge>{" "}
            <span className="font-mono text-xs text-muted-foreground">{c.id}</span> {c.text}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {HOW_LABELS[c.how]}
            {c.verdict === "pass" && c.how === "code_reading" ? ": weaker evidence, nothing was run" : ""}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{c.evidence}</p>
        </li>
      ))}
    </ul>
  );

  const checks = report.checks.length === 0 ? (
    <p className="text-sm text-amber-700 dark:text-amber-300">The agent ran no command. Run the tests yourself before approving.</p>
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

  const issues = report.issues.length ? (
    <ul className="space-y-1.5 text-sm">
      {report.issues.map((i, n) => (
        <li key={n}>
          <Badge variant={i.severity === "high" ? "destructive" : "outline"}>{SEVERITY_LABELS[i.severity]}</Badge> <span className="font-medium text-foreground">{i.title}</span>
          <p className="whitespace-pre-wrap pl-1 text-xs text-muted-foreground">{i.steps}</p>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted-foreground">No issues were reported.</p>
  );

  const byHand = report.manualTests.length ? (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
      {report.manualTests.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted-foreground">Nothing to check by hand.</p>
  );

  return (
    <ReviewDetailFrame
      header={header}
      sections={[
        { id: "summary", label: "Summary", content: summary },
        { id: "criteria", label: "Criteria", count: report.criteria.length, attention: openCriteria > 0, content: criteria },
        { id: "checks", label: "Commands", count: report.checks.length, attention: failedChecks > 0, content: checks },
        { id: "issues", label: "Issues", count: report.issues.length, attention: highIssues > 0, content: issues },
        { id: "hand", label: "By hand", count: report.manualTests.length, content: byHand },
      ]}
      bar={
        <DecisionBar
          stage="qa"
          pending={decide.isPending}
          notice={noAccess}
          blocker={(decision, reason) => noAccess ?? qaDecisionBlocker(decision, reason)}
          onDecide={(decision, reason) => decide.mutate({ decision, reason })}
        />
      }
    />
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5 bg-muted/40 p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium text-foreground ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function MetricsLoader({ companyId }: { companyId: string }) {
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowQa.metrics(companyId),
    queryFn: () => devflowQaApi.metrics(companyId, 30),
    refetchInterval: 60_000,
  });
  const m = metricsQuery.data;
  if (!m) return <p className="p-3 text-sm text-muted-foreground">{metricsQuery.isLoading ? "Loading..." : "Metrics are not available right now."}</p>;
  return <MetricsBody m={m} />;
}

function MetricsBody({ m }: { m: QaMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  const r = m.recommendation;
  return (
    <div className="space-y-4 p-3">
      <p className="text-xs text-muted-foreground">Last 30 days</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <MetricStat label="Waiting" value={String(m.queue.waiting)} hint={m.queue.oldestSince ? `oldest ${agoLabel(m.queue.oldestSince)}` : undefined} />
        <MetricStat label="Against the advice" value={againstRateText(r.againstRate)} hint={`${r.approvedAgainst} approved despite "changes", ${r.returnedAgainst} sent back despite "approve"`} />
        <MetricStat label="Time in sign-off" value={durationLabel(m.flow.secondsInReview.p50)} hint={`p90 ${durationLabel(m.flow.secondsInReview.p90)}`} />
        <MetricStat label="Decisions" value={String(decided)} hint={`${m.decisions.approve} approved, ${m.decisions.reject} rejected, ${m.decisions.requestChanges} sent back`} />
        <MetricStat label="Spent" value={usd(m.agent.spendUsd)} hint={`${m.agent.runs} runs, ${usd(m.agent.avgUsdPerRun)} each`} />
        <MetricStat label="Agent problems" value={String(m.agent.failed + m.agent.gaveUp)} hint={`${m.agent.failedRuns} failed runs, ${m.agent.gaveUp} given up`} />
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
                {QA_FAILURE_LABELS[f.action] ?? f.action}
                {f.kind ? `: ${f.kind}` : ""} <span className="text-muted-foreground">{agoLabel(f.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MetricStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold text-foreground">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
