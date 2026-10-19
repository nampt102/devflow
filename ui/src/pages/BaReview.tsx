import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ClipboardList, ExternalLink, Loader2, Paperclip, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/lib/router";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ApiError } from "../api/client";
import { devflowBaApi, type BaDecision, type BaDetail } from "../api/devflowBa";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ageLabel, agoLabel, isNewSince } from "../lib/triage-review";
import { toggleSystem } from "../lib/triage-review";
import { changedSpecFields, citationLabel, citationUrl, CONFIDENCE_LABEL, decisionBlocker, draftFromSpec, FIELD_LABELS, finalPatch, readSeenAt, writeSeenAt, type BaDraft } from "../lib/ba-review";

// DevFlow BA review: staff read the agent's draft spec with its citations, correct it, and decide.
// Fields the reviewer changes become overrides on the server; an untouched form accepts the spec as it is.

export function BaReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const queueQuery = useQuery({
    queryKey: queryKeys.devflowBa.queue(selectedCompanyId ?? "none"),
    queryFn: () => devflowBaApi.queue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const items = queueQuery.data?.items ?? [];
  const newCount = items.filter((i) => isNewSince(i.proposedAt, seenAt)).length;
  const activeId = selectedId && items.some((i) => i.caseId === selectedId) ? selectedId : (items[0]?.caseId ?? null);

  if (!selectedCompanyId) return <EmptyState icon={ClipboardList} message="Select an organization to review BA specs." />;
  if (queueQuery.isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">BA review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {items.length} spec{items.length === 1 ? "" : "s"} waiting{newCount > 0 ? ` (${newCount} new since your last visit)` : ""}. The BA agent only drafts; your decision moves the request on.
        </p>
      </div>
      {queueQuery.error ? <p className="text-sm text-amber-700 dark:text-amber-300">The queue could not be loaded. Try again in a moment.</p> : null}

      {items.length === 0 ? (
        <EmptyState icon={Check} message="No BA spec is waiting for review." description="A spec appears here after the BA agent has read the request and the systems assigned to it." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <ul className="space-y-2 lg:col-span-1" aria-label="Specs waiting for review">
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
    queryKey: queryKeys.devflowBa.detail(companyId, caseId),
    queryFn: () => devflowBaApi.detail(companyId, caseId),
  });
  if (detailQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (detailQuery.error || !detailQuery.data) return <EmptyState icon={AlertTriangle} message="This request is no longer waiting for review." />;
  return <ReviewForm key={detailQuery.data.outputId} companyId={companyId} detail={detailQuery.data} onDecided={onDecided} />;
}

function ReviewForm({ companyId, detail, onDecided }: { companyId: string; detail: BaDetail; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const base = useMemo(() => draftFromSpec(detail.spec), [detail]);
  const [draft, setDraft] = useState<BaDraft>(base);
  const [reason, setReason] = useState("");
  const [systemIds, setSystemIds] = useState<string[]>(detail.systems.selectedIds);
  const changed = changedSpecFields(detail.spec, draft);
  const systemsChanged = systemIds.length !== detail.systems.selectedIds.length || systemIds.some((id) => !detail.systems.selectedIds.includes(id));
  const set = (key: keyof BaDraft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const decide = useMutation({
    mutationFn: (decision: BaDecision) =>
      devflowBaApi.decide(companyId, detail.caseId, {
        outputId: detail.outputId,
        expectedVersion: detail.version,
        decision,
        reason: reason.trim() || undefined,
        // text corrections only count when approving; a new set of systems also counts when sending the spec back
        ...(decision === "approve" ? { final: finalPatch(detail.spec, draft) } : {}),
        ...(decision !== "reject" && systemsChanged ? { systemIds } : {}),
      }),
    onSuccess: async (result) => {
      pushToast({
        title: `${detail.caseKey} ${result.decision === "approve" ? "approved" : result.decision === "reject" ? "rejected" : "sent back"}`,
        body: result.overriddenFields.length ? `Corrected: ${result.overriddenFields.map((f) => FIELD_LABELS[f as keyof typeof FIELD_LABELS] ?? f).join(", ")}` : undefined,
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowBa.queue(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowBa.count(companyId) });
      onDecided();
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
  const blocker = (decision: BaDecision) => decisionBlocker(decision, draft, reason);
  const corrections = changed.length + (systemsChanged ? 1 : 0);
  const spec = detail.spec;

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
          <h3 className="text-sm font-semibold text-foreground">BA spec (draft by the agent)</h3>
          <span className="text-xs text-muted-foreground">
            prompt {detail.promptVersion}
            {detail.model ? `, ${detail.model}` : ""}, {CONFIDENCE_LABEL[spec.confidence] ?? spec.confidence}
            {detail.costUsd !== null ? `, cost ${detail.costUsd.toFixed(2)} USD` : ""}
          </span>
        </div>
        <TextBox id="ba-summary" label="Summary" value={draft.summary} rows={3} onChange={(v) => set("summary", v)} edited={changed.includes("summary")} />
        <TextBox id="ba-goal" label="Business goal" value={draft.businessGoal} rows={2} onChange={(v) => set("businessGoal", v)} edited={changed.includes("businessGoal")} />
        <TextBox id="ba-inscope" label="In scope (one per line)" value={draft.inScope} rows={3} onChange={(v) => set("inScope", v)} edited={changed.includes("inScope")} />
        <TextBox id="ba-outscope" label="Out of scope (one per line)" value={draft.outOfScope} rows={2} onChange={(v) => set("outOfScope", v)} edited={changed.includes("outOfScope")} />
        <TextBox id="ba-stories" label="User stories (one per line: who | what | why)" value={draft.userStories} rows={3} onChange={(v) => set("userStories", v)} edited={changed.includes("userStories")} />
        <TextBox id="ba-criteria" label="Acceptance criteria (one per line)" value={draft.acceptanceCriteria} rows={5} onChange={(v) => set("acceptanceCriteria", v)} edited={changed.includes("acceptanceCriteria")} />
        <TextBox id="ba-data" label="Data changes (one per line)" value={draft.dataChanges} rows={2} onChange={(v) => set("dataChanges", v)} edited={changed.includes("dataChanges")} />
        <TextBox id="ba-risks" label="Risks (one per line)" value={draft.risks} rows={2} onChange={(v) => set("risks", v)} edited={changed.includes("risks")} />
        <TextBox id="ba-questions" label="Open questions (one per line)" value={draft.openQuestions} rows={3} onChange={(v) => set("openQuestions", v)} edited={changed.includes("openQuestions")} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Where the agent looked</h3>
        {detail.repos.length ? (
          <p className="text-xs text-muted-foreground">
            {detail.repos.map((r) => `${r.name} at commit ${r.sha.slice(0, 8)}`).join("; ")}
          </p>
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
      </section>

      <section className="space-y-1">
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
      </section>

      <section className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="ba-reason">
          Reason (required to reject or request changes)
        </label>
        <Textarea id="ba-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Tell the agent or the requester what to change" />
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
            {corrections ? `Approve with ${corrections} correction${corrections === 1 ? "" : "s"}` : "Approve"}
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
