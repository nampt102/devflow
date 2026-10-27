import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRightLeft, Bot, CheckCheck, FilePlus2, GitPullRequest, History, Mail, PencilLine, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Link, useParams } from "@/lib/router";
import { devflowHistoryApi, type HistoryKind } from "../api/devflowHistory";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { usd } from "../lib/ba-review";
import { queryKeys } from "../lib/queryKeys";
import { costByRole, filterItems, itemLinks, KIND_LABELS, requestSummary, stageDuration } from "../lib/request-history";
import { agoLabel } from "../lib/triage-review";

// DevFlow request history for staff (openspec change add-request-history): what the request is, where it has been and for
// how long, what reviewers changed against the agent, every agent run with its cost, and the emails sent to the requester.
// Read-only: decisions are made on the review pages.

const KIND_ICON: Record<HistoryKind, LucideIcon> = {
  submitted: FilePlus2,
  stage: ArrowRightLeft,
  decision: CheckCheck,
  field_change: PencilLine,
  proposal: GitPullRequest,
  agent_run: Bot,
  agent_failed: TriangleAlert,
  email: Mail,
};

export function RequestHistory() {
  const { caseKey } = useParams<{ caseKey: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [keyOnly, setKeyOnly] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Requests" }, { label: caseKey ?? "History" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, caseKey]);

  const query = useQuery({
    queryKey: queryKeys.devflowHistory.detail(selectedCompanyId ?? "none", caseKey ?? ""),
    queryFn: () => devflowHistoryApi.get(selectedCompanyId!, caseKey!),
    enabled: !!selectedCompanyId && !!caseKey,
    retry: false,
  });

  if (!selectedCompanyId) return <EmptyState icon={History} message="Select an organization to see a request's history." />;
  if (query.isLoading) return <PageSkeleton variant="detail" />;
  if (query.error || !query.data) return <EmptyState icon={AlertTriangle} message="This request was not found." description="Check the key, or the request belongs to another organization." />;

  const h = query.data;
  const items = filterItems(h.items, keyOnly);
  const perRole = costByRole(h.items);
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{h.request.caseKey}</span> · from {h.request.requesterName}, {agoLabel(h.request.createdAt)} · {requestSummary(h)} · now at {h.request.stageName}
        </p>
        <h1 className="text-xl font-semibold tracking-normal text-foreground">{h.request.title}</h1>
        <p className="whitespace-pre-wrap text-sm text-foreground">{h.request.description}</p>
        {h.request.businessImpact ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Business impact:</span> {h.request.businessImpact}
          </p>
        ) : null}
      </header>

      <section className="grid gap-4 lg:grid-cols-3" aria-label="Summary">
        <div className="space-y-1 bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">Agent cost</p>
          <p className="font-mono text-lg font-semibold text-foreground">{usd(h.costUsd)}</p>
          <p className="text-xs text-muted-foreground">{perRole.length ? perRole.map((r) => `${r.role} ${usd(r.usd)}`).join(" · ") : "no agent has run yet"}</p>
        </div>
        <div className="space-y-1 bg-muted/40 p-3 lg:col-span-2">
          <p className="text-xs text-muted-foreground">Time in each stage</p>
          {h.stages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stage data.</p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground">
              {h.stages.map((s, i) => (
                <li key={i}>
                  {s.name} <span className="font-mono text-xs text-muted-foreground">{stageDuration(s.enteredAt, s.leftAt)}{s.leftAt ? "" : " so far"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="space-y-2" aria-label="Timeline">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Timeline</h2>
          <span role="group" aria-label="Which entries" className="flex gap-1">
            <Button type="button" size="sm" variant={keyOnly ? "ghost" : "outline"} aria-pressed={!keyOnly} onClick={() => setKeyOnly(false)}>Everything</Button>
            <Button type="button" size="sm" variant={keyOnly ? "outline" : "ghost"} aria-pressed={keyOnly} onClick={() => setKeyOnly(true)}>Decisions and changes</Button>
          </span>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded for this request yet.</p>
        ) : (
          <ol className="space-y-1">
            {items.map((item, i) => {
              const Icon = KIND_ICON[item.kind];
              const reason = typeof item.details.reason === "string" ? item.details.reason : null;
              const links = itemLinks(item);
              const bad = item.kind === "agent_failed" || (item.kind === "agent_run" && item.details.ok === false);
              return (
                <li key={i} className="flex gap-3 border-b border-border py-2 last:border-0">
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${bad ? "text-destructive" : "text-muted-foreground"}`} aria-hidden />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm text-foreground">
                      <span className="sr-only">{KIND_LABELS[item.kind]}: </span>
                      {item.summary}
                      {item.actor ? <span className="text-muted-foreground"> · {item.actor}</span> : null}
                    </p>
                    {reason ? <p className="text-xs text-muted-foreground">Reason: {reason}</p> : null}
                    {item.kind === "agent_run" && typeof item.details.costUsd === "number" ? (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{usd(item.details.costUsd)}</span>
                        {typeof item.details.promptVersion === "string" ? ` · prompt ${item.details.promptVersion}` : ""}
                      </p>
                    ) : null}
                    {links.map((l) => (
                      <a key={l.url} className="mr-3 text-xs text-primary underline-offset-4 hover:underline" href={l.url} target="_blank" rel="noreferrer noopener">
                        {l.label}
                      </a>
                    ))}
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                    {agoLabel(item.at)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">
          Showing the latest {h.items.length} entries. Decisions are made on the review pages; <Link to="/triage" className="underline underline-offset-2">go to Triage review</Link>.
        </p>
      </section>
    </div>
  );
}
