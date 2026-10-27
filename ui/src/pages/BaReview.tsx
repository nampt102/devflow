import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ClipboardList, ExternalLink, Paperclip } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/lib/router";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { DecisionBar } from "../components/review/DecisionBar";
import { ReviewDetailFrame } from "../components/review/ReviewDetailFrame";
import { ReviewWorkspace } from "../components/review/ReviewWorkspace";
import { ApiError } from "../api/client";
import { devflowBaApi, type BaDecision, type BaDetail, type BaMetrics, type BaQueueItem } from "../api/devflowBa";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { statusLine, type StatusLine } from "../lib/review-workspace";
import { ageLabel, agoLabel, durationLabel, pct, toggleSystem } from "../lib/triage-review";
import { changedSpecFields, citationLabel, citationUrl, CONFIDENCE_LABEL, decisionBlocker, draftFromSpec, FAILURE_LABELS, FIELD_LABELS, finalPatch, readSeenAt, usd, writeSeenAt, type BaDraft } from "../lib/ba-review";

// DevFlow BA review on the shared review workspace: staff read the agent's draft spec with its citations, correct it, and
// decide. Fields the reviewer changes become overrides on the server; an untouched form accepts the spec as it is.

function itemStatus(item: BaQueueItem): StatusLine {
  const p = item.proposal;
  return statusLine([
    p.confidence === "low" ? { tone: "warn", icon: "alert-triangle", text: "Low confidence" } : null,
    p.openQuestions > 0 ? { tone: "warn", icon: "alert-triangle", text: `${p.openQuestions} open question${p.openQuestions === 1 ? "" : "s"}` } : null,
    { tone: "ok", icon: "check", text: `${p.acceptanceCriteria} acceptance criteria` },
  ]);
}

export function BaReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  // When the reviewer last left this page: anything that arrived since carries a "New" label.
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    if (!selectedCompanyId) return;
    setSeenAt(readSeenAt(selectedCompanyId));
    const mark = () => writeSeenAt(selectedCompanyId);
    window.addEventListener("pagehide", mark);
    return () => {
      mark();
      window.removeEventListener("pagehide", mark);
    };
  }, [selectedCompanyId]);
  useEffect(() => {
    setBreadcrumbs([{ label: "BA review" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={ClipboardList} message="Select an organization to review BA specs." />;
  const companyId = selectedCompanyId;
  return (
    <ReviewWorkspace<BaQueueItem>
      title="BA review"
      noun="specs"
      emptyIcon={Check}
      emptyHint="A spec appears here after the BA agent has read the request and the systems assigned to it. The BA agent only drafts; your decision moves the request on."
      queueKey={queryKeys.devflowBa.queue(companyId)}
      loadQueue={() => devflowBaApi.queue(companyId)}
      statusLine={itemStatus}
      subLine={(i) => (i.proposal.systems.length ? i.proposal.systems.join(", ") : null)}
      seenAt={seenAt}
      metrics={<MetricsLoader companyId={companyId} />}
      invalidateOnDecided={async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowBa.queue(companyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.devflowBa.count(companyId) });
      }}
      renderDetail={(item, ctx) => <DetailPanel key={item.caseId} companyId={companyId} caseId={item.caseId} onDecided={ctx.onDecided} />}
    />
  );
}

function DetailPanel({ companyId, caseId, onDecided }: { companyId: string; caseId: string; onDecided: (id: string) => void }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.devflowBa.detail(companyId, caseId),
    queryFn: () => devflowBaApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: BaDetail; onDecided: (id: string) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const base = useMemo(() => draftFromSpec(detail.spec), [detail]);
  const [draft, setDraft] = useState<BaDraft>(base);
  const [systemIds, setSystemIds] = useState<string[]>(detail.systems.selectedIds);
  const changed = changedSpecFields(detail.spec, draft);
  const systemsChanged = systemIds.length !== detail.systems.selectedIds.length || systemIds.some((id) => !detail.systems.selectedIds.includes(id));
  const set = (key: keyof BaDraft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const decide = useMutation({
    mutationFn: (v: { decision: BaDecision; reason: string }) =>
      devflowBaApi.decide(companyId, detail.caseId, {
        outputId: detail.outputId,
        expectedVersion: detail.version,
        decision: v.decision,
        reason: v.reason.trim() || undefined,
        // text corrections only count when approving; a new set of systems also counts when sending the spec back
        ...(v.decision === "approve" ? { final: finalPatch(detail.spec, draft) } : {}),
        ...(v.decision !== "reject" && systemsChanged ? { systemIds } : {}),
      }),
    onSuccess: (result) => {
      pushToast({
        title: `${detail.caseKey} ${result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back"}`,
        body: result.overriddenFields.length ? `Corrected: ${result.overriddenFields.map((f) => FIELD_LABELS[f as keyof typeof FIELD_LABELS] ?? f).join(", ")}` : undefined,
        tone: "success",
      });
      onDecided(detail.caseId);
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      pushToast({
        title: conflict ? "Already handled" : "Decision not saved",
        body: conflict ? "Someone else decided this request or the spec changed. The queue was refreshed." : error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowBa.queue(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowBa.detail(companyId, detail.caseId) });
    },
  });
  const noAccess = accessBlocker(detail);
  const corrections = changed.length + (systemsChanged ? 1 : 0);
  const spec = detail.spec;

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

  const request = (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-sm text-foreground">{detail.description}</p>
      {detail.businessImpact ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Business impact:</span> {detail.businessImpact}
        </p>
      ) : null}
      {detail.attachments.length ? (
        <ul className="flex flex-wrap gap-2">
          {detail.attachments.map((a) => (
            <li key={a.id}>
              <a className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={a.contentPath} target="_blank" rel="noreferrer">
                <Paperclip className="h-3.5 w-3.5" /> {a.name ?? "file"}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const specForm = (
    <div className="space-y-3 bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">
        Draft by the agent: prompt {detail.promptVersion}
        {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[spec.confidence] ?? spec.confidence}
        {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
      </p>
      <TextBox id="ba-summary" label="Summary" value={draft.summary} rows={3} onChange={(v) => set("summary", v)} edited={changed.includes("summary")} />
      <TextBox id="ba-goal" label="Business goal" value={draft.businessGoal} rows={2} onChange={(v) => set("businessGoal", v)} edited={changed.includes("businessGoal")} />
      <TextBox id="ba-inscope" label="In scope (one per line)" value={draft.inScope} rows={3} onChange={(v) => set("inScope", v)} edited={changed.includes("inScope")} />
      <TextBox id="ba-outscope" label="Out of scope (one per line)" value={draft.outOfScope} rows={2} onChange={(v) => set("outOfScope", v)} edited={changed.includes("outOfScope")} />
      <TextBox id="ba-stories" label="User stories (one per line: who | what | why)" value={draft.userStories} rows={3} onChange={(v) => set("userStories", v)} edited={changed.includes("userStories")} />
      <TextBox id="ba-criteria" label="Acceptance criteria (one per line)" value={draft.acceptanceCriteria} rows={5} onChange={(v) => set("acceptanceCriteria", v)} edited={changed.includes("acceptanceCriteria")} />
      <TextBox id="ba-data" label="Data changes (one per line)" value={draft.dataChanges} rows={2} onChange={(v) => set("dataChanges", v)} edited={changed.includes("dataChanges")} />
      <TextBox id="ba-risks" label="Risks (one per line)" value={draft.risks} rows={2} onChange={(v) => set("risks", v)} edited={changed.includes("risks")} />
      <TextBox id="ba-questions" label="Open questions (one per line)" value={draft.openQuestions} rows={3} onChange={(v) => set("openQuestions", v)} edited={changed.includes("openQuestions")} />
    </div>
  );

  const evidence = (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Where the agent looked</p>
        {detail.repos.length ? (
          <p className="text-xs text-muted-foreground">{detail.repos.map((r) => `${r.name} at commit ${r.sha.slice(0, 8)}`).join("; ")}</p>
        ) : (
          <p className="text-xs text-muted-foreground">No repository was read: the spec comes from the request alone.</p>
        )}
        {spec.affectedAreas.length === 0 ? (
          <p className="text-sm text-muted-foreground">The agent cited no code.</p>
        ) : (
          <ul className="space-y-1">
            {spec.affectedAreas.map((a, i) => {
              const url = citationUrl(detail.repos, a);
              return (
                <li key={i} className="text-sm">
                  <span className="text-muted-foreground">{a.system}</span>{" "}
                  {url ? (
                    <a className="inline-flex items-center gap-1 font-mono text-xs text-primary underline-offset-4 hover:underline" href={url} target="_blank" rel="noreferrer noopener">
                      {citationLabel(a)} <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-foreground">{citationLabel(a)}</span>
                  )}
                  <span className="text-muted-foreground"> {a.why}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          Systems the agent reads
          {systemsChanged ? <span className="ml-2 text-amber-700 dark:text-amber-300">Changed from the current list</span> : null}
        </p>
        {detail.systems.available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No systems are set up. <Link to="/systems" className="text-primary underline-offset-4 hover:underline">Add them</Link> first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {detail.systems.available.map((x) => (
              <label key={x.id} className="flex items-center gap-2 text-sm text-foreground" title={x.description || undefined}>
                <Checkbox checked={systemIds.includes(x.id)} onCheckedChange={(v) => setSystemIds((cur) => toggleSystem(cur, x.id, v === true))} aria-label={x.name} />
                {x.name}
              </label>
            ))}
          </div>
        )}
        {systemsChanged ? <p className="text-xs text-muted-foreground">Choose "Request changes" to have the agent write the spec again with these systems; approving keeps this choice for the next stage.</p> : null}
      </div>
    </div>
  );

  return (
    <ReviewDetailFrame
      header={header}
      sections={[
        { id: "request", label: "Request", count: detail.attachments.length || undefined, content: request },
        { id: "spec", label: changed.length ? `Spec (${changed.length} edited)` : "Spec", content: specForm },
        { id: "evidence", label: systemsChanged ? "Evidence (systems changed)" : "Evidence", count: spec.affectedAreas.length, content: evidence },
      ]}
      bar={
        <DecisionBar
          stage="ba"
          pending={decide.isPending}
          notice={noAccess ?? (corrections ? "Text you edited is kept only when you approve." : null)}
          approveLabel={corrections ? `Approve with ${corrections} correction${corrections === 1 ? "" : "s"}` : undefined}
          blocker={(decision, reason) => noAccess ?? decisionBlocker(decision, draft, reason)}
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
    queryKey: queryKeys.devflowBa.metrics(companyId),
    queryFn: () => devflowBaApi.metrics(companyId, 30),
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

function MetricsBody({ m }: { m: BaMetrics }) {
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
          <p className="mb-1 text-xs font-medium text-muted-foreground">Share of approved specs corrected, by field</p>
          {m.fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">No corrections yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {m.fields.map((f) => (
                  <tr key={f.field} className="border-b border-border last:border-0">
                    <td className="py-1 text-foreground">{FIELD_LABELS[f.field as keyof typeof FIELD_LABELS] ?? f.field}</td>
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
                  {FAILURE_LABELS[f.action] ?? f.action}
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
