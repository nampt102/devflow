import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardCheck, ExternalLink, Loader2, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ApiError } from "../api/client";
import { devflowQaApi, type QaDecision, type QaDetail, type QaMetrics } from "../api/devflowQa";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { CONFIDENCE_LABEL, usd } from "../lib/ba-review";
import { decisionSummary, safeGithubUrl } from "../lib/code-review";
import { QA_FAILURE_LABELS, SEVERITY_LABELS, VERDICT_LABELS, HOW_LABELS, WARNING_LABELS, againstRateText, criteriaSummary, qaDecisionBlocker, readQaSeenAt, reasonLabel, recommendationText, writeQaSeenAt } from "../lib/qa-review";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { ageLabel, agoLabel, durationLabel, isNewSince } from "../lib/triage-review";

// DevFlow QA sign-off: staff read the QA agent's report (each acceptance criterion with its verdict and evidence, the commands it
// ran, the issues it found, what a person still has to check) next to DevFlow's own recommendation, and decide. The
// recommendation is advice: approving is always possible. Approving finishes the request; nothing is merged.

export function QaSignoff() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const queueQuery = useQuery({
    queryKey: queryKeys.devflowQa.queue(selectedCompanyId ?? "none"),
    queryFn: () => devflowQaApi.queue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const items = queueQuery.data?.items ?? [];
  const newCount = items.filter((i) => isNewSince(i.proposedAt, seenAt)).length;
  const activeId = selectedId && items.some((i) => i.caseId === selectedId) ? selectedId : (items[0]?.caseId ?? null);

  if (!selectedCompanyId) return <EmptyState icon={ClipboardCheck} message="Select an organization to sign off QA." />;
  if (queueQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">QA sign-off</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {items.length} report{items.length === 1 ? "" : "s"} waiting{newCount > 0 ? ` (${newCount} new since your last visit)` : ""}. The QA agent only checks and reports; your decision finishes the request or sends it back to Dev.
        </p>
      </div>
      {queueQuery.error ? <p className="text-sm text-amber-700 dark:text-amber-300">The queue could not be loaded. Try again in a moment.</p> : null}

      <MetricsPanel companyId={selectedCompanyId} />

      {items.length === 0 ? (
        <EmptyState icon={Check} message="No QA report is waiting for sign-off." description="A report appears here after the QA agent has checked the pull request of a request whose code was approved." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1" aria-label="QA reports waiting for sign-off">
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
                  <p className="mt-1 text-xs text-muted-foreground">{criteriaSummary(item.proposal.criteria)}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant={item.proposal.recommendation === "approve" ? "secondary" : "destructive"}>
                      {item.proposal.recommendation === "approve" ? "Recommends approval" : item.proposal.recommendation === "changes" ? "Recommends changes" : "No recommendation"}
                    </Badge>
                    {item.proposal.pullRequests.map((p) => (
                      <Badge key={p.url} variant="outline">PR #{p.number} ({p.system})</Badge>
                    ))}
                    {item.proposal.checks.failed > 0 ? <Badge variant="destructive">{item.proposal.checks.failed} command{item.proposal.checks.failed === 1 ? "" : "s"} failed</Badge> : null}
                    {item.proposal.issues.high > 0 ? <Badge variant="destructive">{item.proposal.issues.high} high issue{item.proposal.issues.high === 1 ? "" : "s"}</Badge> : null}
                    {item.proposal.warnings.length > 0 ? <Badge variant="outline">Warning</Badge> : null}
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
    queryKey: queryKeys.devflowQa.detail(companyId, caseId),
    queryFn: () => devflowQaApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for sign-off." />;
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: QaDetail; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [reason, setReason] = useState("");

  const decide = useMutation({
    mutationFn: (decision: QaDecision) => devflowQaApi.decide(companyId, detail.caseId, { outputId: detail.outputId, expectedVersion: detail.version, decision, reason: reason.trim() || undefined }),
    onSuccess: async (result) => {
      const s = decisionSummary(detail.caseKey, result);
      pushToast({ title: s.title, body: s.body, tone: s.tone });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowQa.queue(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowQa.count(companyId) });
      onDecided();
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
  const blocker = (decision: QaDecision) => noAccess ?? qaDecisionBlocker(decision, reason);
  const report = detail.report;
  const rec = detail.recommendation;

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

      <section className="space-y-2 bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={rec.value === "approve" ? "secondary" : "destructive"}>{recommendationText(rec.value)}</Badge>
          <span className="text-xs text-muted-foreground">
            prompt {detail.promptVersion}
            {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[report.confidence] ?? report.confidence}
            {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
          </span>
        </div>
        {rec.reasons.length ? (
          <ul className="list-disc pl-5 text-sm text-foreground">
            {rec.reasons.map((r) => (
              <li key={r}>{reasonLabel(r)}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">The recommendation is DevFlow's own reading of the report. You decide.</p>
        <p className="whitespace-pre-wrap text-sm text-foreground">{report.summary}</p>
      </section>

      {detail.warnings.length ? (
        <section className="space-y-1" role="alert">
          {detail.warnings.map((w) => (
            <p key={w} className="text-sm text-amber-700 dark:text-amber-300">{WARNING_LABELS[w] ?? w}</p>
          ))}
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Pull requests</h3>
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
                <span className="ml-2 text-xs text-muted-foreground">checked commit {r.testedSha.slice(0, 8)}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Acceptance criteria</h3>
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
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Commands the agent ran</h3>
        {report.checks.length === 0 ? (
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
        )}
      </section>

      {report.issues.length ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Issues found</h3>
          <ul className="space-y-1.5 text-sm">
            {report.issues.map((i, n) => (
              <li key={n}>
                <Badge variant={i.severity === "high" ? "destructive" : "outline"}>{SEVERITY_LABELS[i.severity]}</Badge> <span className="font-medium text-foreground">{i.title}</span>
                <p className="whitespace-pre-wrap pl-1 text-xs text-muted-foreground">{i.steps}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.manualTests.length ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Check by hand</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {report.manualTests.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2 border-t border-border pt-4">
        <label className="text-sm font-medium text-foreground" htmlFor="qa-reason">
          Reason (required to reject or request changes)
        </label>
        <Textarea id="qa-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Tell the developer agent or the requester what to change" />
        <p className="text-xs text-muted-foreground">
          "Request changes" sends the request back to Dev with your reason and what QA found; the pull request stays open and the agent continues on the same branch. "Reject" closes the pull request (the branch stays) and cancels the request. Approving finishes the request and merges nothing.
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
    queryKey: queryKeys.devflowQa.metrics(companyId),
    queryFn: () => devflowQaApi.metrics(companyId, 30),
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
            {m.recommendation.decided === 0 ? "no sign-offs yet" : `${againstRateText(m.recommendation.againstRate)} of ${m.recommendation.decided} sign-offs went against the recommendation`}; {usd(m.agent.spendUsd)} spent
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

function MetricsBody({ m }: { m: QaMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  const r = m.recommendation;
  return (
    <div className="space-y-4 border-t border-border p-3">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Waiting" value={String(m.queue.waiting)} hint={m.queue.oldestSince ? `oldest ${ageLabel(m.queue.oldestSince)}` : undefined} />
        <Stat label="Against the advice" value={againstRateText(r.againstRate)} hint={`${r.approvedAgainst} approved despite "changes", ${r.returnedAgainst} sent back despite "approve"`} />
        <Stat label="Time in sign-off" value={durationLabel(m.flow.secondsInReview.p50)} hint={`p90 ${durationLabel(m.flow.secondsInReview.p90)}`} />
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
