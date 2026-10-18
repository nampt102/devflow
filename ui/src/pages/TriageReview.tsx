import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardCheck, Copy, Loader2, Paperclip, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ApiError } from "../api/client";
import { devflowTriageApi, type TriageDecision, type TriageDetail, type TriageMetrics } from "../api/devflowTriage";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  ageLabel,
  changedFields,
  CLASSIFICATIONS,
  decisionBlocker,
  DIFFICULTIES,
  draftFromDetail,
  durationLabel,
  FIELD_LABELS,
  filterQueue,
  finalPatch,
  HUMAN_REASON_LABELS,
  HUMAN_REASONS,
  pct,
  PRIORITIES,
  scoreLabel,
  type QueueFilter,
  type TriageDraft,
} from "../lib/triage-review";

// DevFlow triage review (step 8): staff look at the agent's proposal, correct it, and decide.
// Fields the reviewer changes become overrides on the server; an untouched form accepts the proposal.

const FILTERS: Array<{ key: QueueFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "needs_human", label: "Needs a developer" },
  { key: "possible_duplicate", label: "Possible duplicate" },
];

export function TriageReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Triage review" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const queueQuery = useQuery({
    queryKey: queryKeys.devflowTriage.queue(selectedCompanyId ?? "none"),
    queryFn: () => devflowTriageApi.queue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const all = queueQuery.data?.items ?? [];
  const items = useMemo(() => filterQueue(all, filter), [all, filter]);
  const activeId = selectedId && items.some((i) => i.caseId === selectedId) ? selectedId : (items[0]?.caseId ?? null);

  if (!selectedCompanyId) return <EmptyState icon={ClipboardCheck} message="Select an organization to review triage proposals." />;
  if (queueQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Triage review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {all.length} request{all.length === 1 ? "" : "s"} waiting. The agent only proposes; your decision moves the request on.
        </p>
      </div>

      {queueQuery.error ? <p className="text-sm text-amber-700 dark:text-amber-300">The queue could not be loaded. Try again in a moment.</p> : null}

      <MetricsPanel companyId={selectedCompanyId} />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Queue filter">
        {FILTERS.map((f) => (
          <Button key={f.key} type="button" size="sm" variant={filter === f.key ? "default" : "outline"} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState icon={Check} message={all.length === 0 ? "Nothing is waiting for triage review." : "No request matches this filter."} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1" aria-label="Requests waiting for review">
            {items.map((item) => (
              <li key={item.caseId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(item.caseId)}
                  aria-current={item.caseId === activeId}
                  className={`w-full border p-3 text-left transition-colors hover:bg-accent/50 ${item.caseId === activeId ? "border-primary bg-accent/40" : "border-border"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{item.caseKey}</span>
                    <span className="text-xs text-muted-foreground">{ageLabel(item.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-foreground">{item.title}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="secondary">{item.proposal.classification}</Badge>
                    <Badge variant="outline">{item.proposal.priority}</Badge>
                    {item.proposal.requiresHuman ? <Badge variant="destructive">needs developer</Badge> : null}
                    {item.proposal.duplicateCandidates > 0 ? <Badge variant="outline">possible duplicate</Badge> : null}
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
    queryKey: queryKeys.devflowTriage.detail(companyId, caseId),
    queryFn: () => devflowTriageApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) {
    return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  }
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: TriageDetail; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const base = useMemo(() => draftFromDetail(detail), [detail]);
  const [draft, setDraft] = useState<TriageDraft>(base);
  const [reason, setReason] = useState("");
  const changed = changedFields(base, draft);
  const proposal = detail.proposal;

  const set = <K extends keyof TriageDraft>(key: K, value: TriageDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const was = (field: keyof TriageDraft, text: string) =>
    changed.includes(field) ? <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">Agent proposed: {text}</span> : null;

  const decide = useMutation({
    mutationFn: (decision: TriageDecision) =>
      devflowTriageApi.decide(companyId, detail.caseId, {
        outputId: detail.outputId,
        expectedVersion: detail.version,
        decision,
        reason: reason.trim() || undefined,
        final: decision === "request_changes" ? undefined : finalPatch(base, draft),
      }),
    onSuccess: async (result) => {
      pushToast({
        title: `${detail.caseKey} ${result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back"}`,
        body: result.overriddenFields.length ? `Corrected: ${result.overriddenFields.join(", ")}` : undefined,
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.queue(companyId) });
      onDecided();
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

  const blocker = (decision: TriageDecision) => decisionBlocker(decision, draft, reason);
  const duplicate = detail.candidates.find((c) => c.caseId === draft.duplicateOfCaseId);

  return (
    <div className="space-y-5 border border-border p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">{detail.caseKey}</span>
          <span className="text-xs text-muted-foreground">
            from {detail.requesterName}, {ageLabel(detail.createdAt)} ago
          </span>
        </div>
        <h2 className="text-lg font-semibold text-foreground">{detail.title}</h2>
      </header>

      <section className="space-y-2">
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
      </section>

      <section className="space-y-3 bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Agent proposal</h3>
          <span className="text-xs text-muted-foreground">
            prompt {detail.promptVersion}
            {detail.model ? `, ${detail.model}` : ""}
            {proposal.confidence !== null ? `, confidence ${proposal.confidence}` : ""}
          </span>
        </div>
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
                    onCheckedChange={(v) =>
                      set("requiresHumanReasons", v === true ? [...draft.requiresHumanReasons, r] : draft.requiresHumanReasons.filter((x) => x !== r))
                    }
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

        {proposal.assumptions.length ? <Notes title="Assumptions" lines={proposal.assumptions} /> : null}
        {proposal.openQuestions.length ? <Notes title="Open questions" lines={proposal.openQuestions} /> : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Similar requests</h3>
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
                <Button
                  type="button"
                  size="sm"
                  variant={draft.duplicateOfCaseId === c.caseId ? "default" : "outline"}
                  onClick={() => set("duplicateOfCaseId", draft.duplicateOfCaseId === c.caseId ? null : c.caseId)}
                >
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
      </section>

      <section className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="triage-reason">
          Reason {duplicate ? "(optional for a duplicate)" : "(required to reject or request changes)"}
        </label>
        <Textarea id="triage-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Tell the requester or the agent what to change" />
        <p className="text-xs text-muted-foreground">With "Request changes" the agent sees your reason on its next pass.</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={decide.isPending || !!blocker("request_changes")} title={blocker("request_changes") ?? undefined} onClick={() => decide.mutate("request_changes")}>
              <RotateCcw className="h-4 w-4" /> Request changes
            </Button>
            <Button type="button" variant="destructive" disabled={decide.isPending || !!blocker("reject")} title={blocker("reject") ?? undefined} onClick={() => decide.mutate("reject")}>
              <X className="h-4 w-4" /> {duplicate ? "Reject as duplicate" : "Reject"}
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

function MetricsPanel({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const metricsQuery = useQuery({
    queryKey: queryKeys.devflowTriage.metrics(companyId),
    queryFn: () => devflowTriageApi.metrics(companyId, 30),
    refetchInterval: 60_000,
  });
  const m = metricsQuery.data;
  return (
    <section className="border border-border">
      <button type="button" className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium text-foreground" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Quality, last 30 days
        {m ? (
          <span className="font-normal text-muted-foreground">
            {m.approved.total === 0 ? "no approved proposals yet" : `${pct(m.approved.overrideRate)} of ${m.approved.total} approved proposals were corrected`}
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

function MetricsBody({ m }: { m: TriageMetrics }) {
  const decided = m.decisions.approve + m.decisions.reject + m.decisions.requestChanges;
  return (
    <div className="space-y-4 border-t border-border p-3">
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
                    {f.kind ? ` (${f.kind})` : ""} <span className="text-muted-foreground">{ageLabel(f.at)} ago</span>
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
