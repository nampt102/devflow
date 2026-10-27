import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ClipboardCheck, Copy, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Link } from "@/lib/router";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { DecisionBar } from "../components/review/DecisionBar";
import { ReviewDetailFrame } from "../components/review/ReviewDetailFrame";
import { ReviewWorkspace } from "../components/review/ReviewWorkspace";
import { ApiError } from "../api/client";
import { devflowTriageApi, type TriageDecision, type TriageDetail, type TriageMetrics, type TriageQueueItem } from "../api/devflowTriage";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { accessBlocker } from "../lib/roles";
import { statusLine, type StatusLine } from "../lib/review-workspace";
import {
  ageLabel,
  agoLabel,
  changedFields,
  CLASSIFICATIONS,
  decisionBlocker,
  DIFFICULTIES,
  draftFromDetail,
  durationLabel,
  FIELD_LABELS,
  finalPatch,
  HUMAN_REASON_LABELS,
  HUMAN_REASONS,
  pct,
  readOrder,
  readSeenAt,
  writeOrder,
  writeSeenAt,
  PRIORITIES,
  scoreLabel,
  type TriageDraft,
  systemsDiffer,
  toggleSystem,
} from "../lib/triage-review";

// DevFlow triage review on the shared review workspace: staff look at the agent's proposal, correct it, and decide.
// Fields the reviewer changes become overrides on the server; an untouched form accepts the proposal.

function itemStatus(item: TriageQueueItem): StatusLine {
  const p = item.proposal;
  return statusLine([
    p.requiresHuman ? { tone: "warn", icon: "alert-triangle", text: "Needs a developer" } : null,
    p.duplicateCandidates > 0 ? { tone: "warn", icon: "rotate", text: "Possible duplicate" } : null,
    { tone: "ok", icon: "check", text: `${p.classification} · ${p.priority}` },
  ]);
}

export function TriageReview() {
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
    setBreadcrumbs([{ label: "Triage review" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const filters = useMemo(
    () => [
      { key: "all", label: "All", match: () => true },
      { key: "needs_human", label: "Needs a developer", match: (i: TriageQueueItem) => i.proposal.requiresHuman },
      { key: "possible_duplicate", label: "Possible duplicate", match: (i: TriageQueueItem) => i.proposal.duplicateCandidates > 0 },
    ],
    [],
  );

  if (!selectedCompanyId) return <EmptyState icon={ClipboardCheck} message="Select an organization to review triage proposals." />;
  const companyId = selectedCompanyId;
  return (
    <ReviewWorkspace<TriageQueueItem>
      title="Triage review"
      noun="requests"
      emptyIcon={Check}
      emptyHint="A request appears here after the agent has proposed a type, priority and difficulty. The agent only proposes; your decision moves the request on."
      queueKey={queryKeys.devflowTriage.queue(companyId)}
      loadQueue={() => devflowTriageApi.queue(companyId)}
      statusLine={itemStatus}
      filters={filters}
      initialSort={readOrder()}
      onSortChange={writeOrder}
      seenAt={seenAt}
      metrics={<MetricsLoader companyId={companyId} />}
      invalidateOnDecided={() => queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.queue(companyId) })}
      renderDetail={(item, ctx) => <DetailPanel key={item.caseId} companyId={companyId} caseId={item.caseId} onDecided={ctx.onDecided} />}
    />
  );
}

function DetailPanel({ companyId, caseId, onDecided }: { companyId: string; caseId: string; onDecided: (id: string) => void }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.devflowTriage.detail(companyId, caseId),
    queryFn: () => devflowTriageApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) {
    return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  }
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: TriageDetail; onDecided: (id: string) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const base = useMemo(() => draftFromDetail(detail), [detail]);
  const [draft, setDraft] = useState<TriageDraft>(base);
  const [systemIds, setSystemIds] = useState<string[]>(detail.systems.selectedIds);
  const changed = changedFields(base, draft);
  const systemsChanged = systemsDiffer(detail.systems, systemIds);
  const proposal = detail.proposal;

  const set = <K extends keyof TriageDraft>(key: K, value: TriageDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const was = (field: keyof TriageDraft, text: string) =>
    changed.includes(field) ? <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">Agent proposed: {text}</span> : null;

  const decide = useMutation({
    mutationFn: (v: { decision: TriageDecision; reason: string }) =>
      devflowTriageApi.decide(companyId, detail.caseId, {
        outputId: detail.outputId,
        expectedVersion: detail.version,
        decision: v.decision,
        reason: v.reason.trim() || undefined,
        final: v.decision === "request_changes" ? undefined : finalPatch(base, draft),
        // the choice only counts when approving: it decides which repositories the BA agent reads
        ...(v.decision === "approve" ? { systemIds } : {}),
      }),
    onSuccess: (result) => {
      pushToast({
        title: `${detail.caseKey} ${result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back"}`,
        body: result.overriddenFields.length ? `Corrected: ${result.overriddenFields.join(", ")}` : undefined,
        tone: "success",
      });
      onDecided(detail.caseId);
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      pushToast({
        title: conflict ? "Already handled" : "Decision not saved",
        body: conflict ? "Someone else decided this request or the proposal changed. The queue was refreshed." : error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.queue(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.detail(companyId, detail.caseId) });
    },
  });

  const noAccess = accessBlocker(detail);
  const duplicate = detail.candidates.find((c) => c.caseId === draft.duplicateOfCaseId);
  const corrections = changed.length + (systemsChanged ? 1 : 0);

  const header = (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{detail.caseKey}</span> · from {detail.requesterName}, {agoLabel(detail.createdAt)}
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

  const proposalForm = (
    <div className="space-y-3 bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">
        Agent proposal: prompt {detail.promptVersion}
        {detail.model ? `, ${detail.model}` : ""}
        {proposal.confidence !== null ? `, confidence ${proposal.confidence}` : ""}
      </p>
      <p className="text-sm text-foreground">{proposal.summary}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type" note={was("classification", base.classification)} reason={proposal.classificationReason}>
          <Pick value={draft.classification} options={CLASSIFICATIONS} onChange={(v) => set("classification", v)} label="Type" />
        </Field>
        <Field label="Priority" note={was("priority", base.priority)} reason={proposal.priorityReason}>
          <Pick value={draft.priority} options={PRIORITIES} onChange={(v) => set("priority", v)} label="Priority" />
        </Field>
        <Field label="Difficulty" note={was("difficulty", base.difficulty)} reason={proposal.difficultyReason}>
          <Pick value={draft.difficulty} options={DIFFICULTIES} onChange={(v) => set("difficulty", v)} label="Difficulty" />
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={draft.requiresHuman}
            onCheckedChange={(v) => {
              const on = v === true;
              setDraft((d) => ({ ...d, requiresHuman: on, requiresHumanReasons: on ? d.requiresHumanReasons : [] }));
            }}
            aria-label="Needs a developer"
          />
          Needs a developer
          {was("requiresHuman", base.requiresHuman ? "yes" : "no")}
        </label>
        {draft.requiresHuman ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
            {HUMAN_REASONS.map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={draft.requiresHumanReasons.includes(r)}
                  onCheckedChange={(v) => set("requiresHumanReasons", v === true ? [...draft.requiresHumanReasons, r] : draft.requiresHumanReasons.filter((x) => x !== r))}
                  aria-label={HUMAN_REASON_LABELS[r]}
                />
                {HUMAN_REASON_LABELS[r]}
                {proposal.ruleFlags.includes(r) ? <Badge variant="outline">rule</Badge> : null}
              </label>
            ))}
          </div>
        ) : null}
        {changed.includes("requiresHumanReasons") ? <p className="pl-6 text-xs text-amber-700 dark:text-amber-300">Agent proposed: {base.requiresHumanReasons.map((r) => HUMAN_REASON_LABELS[r] ?? r).join(", ") || "none"}</p> : null}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          Systems this request is about
          {systemsChanged ? <span className="ml-2 text-amber-700 dark:text-amber-300">Agent suggested: {detail.systems.suggestedKeys.join(", ") || "none"}</span> : null}
        </p>
        {detail.systems.available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No systems are set up yet. <Link to="/systems" className="text-primary underline-offset-4 hover:underline">Add them</Link> so the BA agent can read their repositories.
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {detail.systems.available.map((x) => (
              <label key={x.id} className="flex items-center gap-2 text-sm text-foreground" title={x.description || undefined}>
                <Checkbox checked={systemIds.includes(x.id)} onCheckedChange={(v) => setSystemIds((cur) => toggleSystem(cur, x.id, v === true))} aria-label={x.name} />
                {x.name}
                {detail.systems.suggestedKeys.includes(x.key) ? <Badge variant="outline">suggested</Badge> : null}
              </label>
            ))}
          </div>
        )}
        {systemIds.length === 0 && detail.systems.available.length > 0 ? <p className="text-xs text-muted-foreground">None selected: the BA agent will write the spec from the request alone.</p> : null}
      </div>

      {proposal.assumptions.length ? <Notes title="Assumptions" lines={proposal.assumptions} /> : null}
      {proposal.openQuestions.length ? <Notes title="Open questions" lines={proposal.openQuestions} /> : null}
    </div>
  );

  const similar = (
    <div className="space-y-2">
      {detail.candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">None found{proposal.dedupeMode ? ` (${proposal.dedupeMode})` : ""}.</p>
      ) : (
        <ul className="space-y-2">
          {detail.candidates.map((c) => (
            <li key={c.caseId} className="flex flex-wrap items-start justify-between gap-2 border border-border p-2">
              <div className="space-y-0.5">
                <p className="text-sm text-foreground">
                  <span className="font-mono text-xs text-muted-foreground">{c.caseKey}</span> {c.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.statusLabel}; text {scoreLabel(c.trigram)}, meaning {scoreLabel(c.vector)}
                  {c.namedByModel ? "; agent says duplicate" : ""}
                </p>
                {c.modelReason ? <p className="text-xs text-muted-foreground">{c.modelReason}</p> : null}
              </div>
              <Button type="button" size="sm" variant={draft.duplicateOfCaseId === c.caseId ? "default" : "outline"} onClick={() => set("duplicateOfCaseId", draft.duplicateOfCaseId === c.caseId ? null : c.caseId)}>
                <Copy className="h-4 w-4" /> {draft.duplicateOfCaseId === c.caseId ? "Marked duplicate" : "Mark duplicate"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {duplicate ? (
        <p className="text-xs text-muted-foreground">
          {duplicate.caseKey} is marked as the original. Reject this request to close it as a duplicate; it cannot be approved while marked.
        </p>
      ) : null}
    </div>
  );

  return (
    <ReviewDetailFrame
      header={header}
      sections={[
        { id: "request", label: "Request", count: detail.attachments.length || undefined, content: request },
        { id: "proposal", label: corrections ? `Proposal (${corrections} edited)` : "Proposal", content: proposalForm },
        { id: "similar", label: "Similar", count: detail.candidates.length, attention: detail.candidates.some((c) => c.namedByModel) || !!duplicate, content: similar },
      ]}
      bar={
        <DecisionBar
          stage="triage"
          pending={decide.isPending}
          notice={noAccess}
          approveLabel={corrections ? `Approve with ${corrections} correction${corrections === 1 ? "" : "s"}` : undefined}
          blocker={(decision, reason) => noAccess ?? decisionBlocker(decision, draft, reason)}
          onDecide={(decision, reason) => decide.mutate({ decision, reason })}
        />
      }
    />
  );
}

function Field({ label, note, reason, children }: { label: string; note: React.ReactNode; reason: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {label}
        {note}
      </p>
      {children}
      <p className="text-xs text-muted-foreground">{reason}</p>
    </div>
  );
}

function Pick({ value, options, onChange, label }: { value: string; options: readonly string[]; onChange: (v: string) => void; label: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Notes({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="list-disc pl-5 text-sm text-foreground">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

const PROBLEM_LABELS: Record<string, string> = {
  "agent.triage_failed": "Triage failed",
  "agent.triage_gave_up": "Triage gave up",
  "agent.embed_failed": "Embedding failed",
  "email.failed": "Email not sent",
  "agent.triage_budget_paused": "Daily token cap reached",
};

function MetricsLoader({ companyId }: { companyId: string }) {
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowTriage.metrics(companyId),
    queryFn: () => devflowTriageApi.metrics(companyId, 30),
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

function MetricsBody({ m }: { m: TriageMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  return (
    <div className="space-y-4 p-3">
      <p className="text-xs text-muted-foreground">Last 30 days</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Waiting" value={String(m.queue.waiting)} hint={m.queue.oldestSince ? `oldest ${ageLabel(m.queue.oldestSince)}` : undefined} />
        <Stat label="Corrected" value={pct(m.approved.overrideRate)} hint={`${m.approved.overridden} of ${m.approved.total} approved`} />
        <Stat label="To first proposal" value={durationLabel(m.flow.secondsToProposal.p50)} hint={`p90 ${durationLabel(m.flow.secondsToProposal.p90)}`} />
        <Stat label="Time in review" value={durationLabel(m.flow.secondsInReview.p50)} hint={`p90 ${durationLabel(m.flow.secondsInReview.p90)}`} />
        <Stat label="Decisions" value={String(decided)} hint={`${m.decisions.approve} approved, ${m.decisions.reject} rejected, ${m.decisions.requestChanges} sent back`} />
        <Stat label="Agent problems" value={String(m.agent.failed + m.agent.gaveUp)} hint={`${m.agent.proposed} proposals, ${m.agent.gaveUp} given up`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Share of approved proposals corrected, by field</p>
          <table className="w-full text-sm">
            <tbody>
              {m.fields.map((f) => (
                <tr key={f.field} className="border-b border-border last:border-0">
                  <td className="py-1 text-foreground">{FIELD_LABELS[f.field] ?? f.field}</td>
                  <td className="py-1 text-right text-foreground">{pct(f.rate)}</td>
                  <td className="py-1 text-right text-muted-foreground">{f.overrides}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.approved.byPromptVersion.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              By prompt: {m.approved.byPromptVersion.map((v) => `${v.promptVersion} ${pct(v.overrideRate)} of ${v.total}`).join(", ")}
            </p>
          ) : null}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Most common corrections</p>
          {m.commonCorrections.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="space-y-1 text-sm text-foreground">
              {m.commonCorrections.slice(0, 6).map((c, i) => (
                <li key={i}>
                  {FIELD_LABELS[c.field] ?? c.field}: {c.agentValue ?? "none"} to {c.finalValue ?? "none"} <span className="text-muted-foreground">x{c.count}</span>
                </li>
              ))}
            </ul>
          )}
          {m.recentFailures.length ? (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Recent problems</p>
              <ul className="space-y-0.5 text-sm text-foreground">
                {m.recentFailures.slice(0, 5).map((f, i) => (
                  <li key={i}>
                    {PROBLEM_LABELS[f.action] ?? f.action}
                    {f.caseKey ? ` on ${f.caseKey}` : ""}
                    {f.kind ? ` (${f.kind})` : ""} <span className="text-muted-foreground">{agoLabel(f.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Duplicates: agent named {m.duplicates.namedByAgent}, reviewers added {m.duplicates.addedByReviewer}, closed as duplicate {m.duplicates.closedAsDuplicate}. Tokens: {m.agent.inputTokens} in, {m.agent.outputTokens} out over {m.agent.calls} calls.
          </p>
        </div>
      </div>
    </div>
  );
}
