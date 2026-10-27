import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Check, ChartBar, Clock, RotateCcw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useSearchParams } from "@/lib/router";
import { ageLabel, isNewSince } from "../../lib/triage-review";
import { filterQueue, moveSelection, pickActive, reviewKeyAction, sortQueue, type QueueSort, type StatusLine } from "../../lib/review-workspace";

// The shared frame of the five review pages (openspec change redesign-review-queues): top bar, compact queue, the detail the
// page supplies, j/k to move, the open item in the URL (?case=REQ-1), a metrics drawer, and two screens on a phone.
// A page supplies what is its own: how to load, one status line per item, and the detail (see ReviewDetailFrame).

export interface WorkspaceItem {
  caseId: string;
  caseKey: string;
  title: string;
  createdAt: string;
  proposedAt: string;
}

export interface ReviewWorkspaceProps<T extends WorkspaceItem> {
  title: string;
  /** what the page reviews, for the empty state ("QA reports") */
  noun: string;
  emptyHint: string;
  emptyIcon: LucideIcon;
  queueKey: readonly unknown[];
  loadQueue: () => Promise<{ items: T[] }>;
  statusLine: (item: T) => StatusLine;
  /** the second line under the title (e.g. "10 of 11 criteria pass"); optional */
  subLine?: (item: T) => string | null;
  /** the viewer's own queue: only when the page can tell from the item; hides the "Mine" filter otherwise */
  canDecide?: (item: T) => boolean;
  seenAt: number | null;
  /** the page's detail for the open item; it owns the decision bar and calls `onDecided` after a decision */
  renderDetail: (item: T, ctx: { onDecided: (decidedId: string) => void }) => ReactNode;
  metrics?: ReactNode;
  invalidateOnDecided?: () => Promise<unknown> | void;
}

const TONE_ICON: Record<StatusLine["icon"], LucideIcon> = { "alert-triangle": AlertTriangle, rotate: RotateCcw, check: Check, clock: Clock };
const TONE_CLASS: Record<StatusLine["tone"], string> = {
  block: "text-destructive",
  warn: "text-amber-700 dark:text-amber-300",
  ok: "text-muted-foreground",
  info: "text-muted-foreground",
};

export function ReviewWorkspace<T extends WorkspaceItem>(props: ReviewWorkspaceProps<T>) {
  const { title, noun, emptyHint, emptyIcon, queueKey, loadQueue, statusLine, subLine, canDecide, seenAt, renderDetail, metrics } = props;
  const [params, setParams] = useSearchParams();
  const wanted = params.get("case");
  const [sort, setSort] = useState<QueueSort>("oldest");
  const [mine, setMine] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const queue = useQuery({ queryKey: queueKey, queryFn: loadQueue, refetchInterval: 30_000 });
  const all = queue.data?.items ?? [];
  const items = useMemo(() => sortQueue(filterQueue(all, mine, canDecide ?? (() => true)), sort), [all, mine, sort, canDecide]);
  const active = pickActive(items, wanted);
  const newCount = all.filter((i) => isNewSince(i.proposedAt, seenAt)).length;
  const oldest = all.length ? ageLabel(all.reduce((a, b) => (new Date(a.createdAt) < new Date(b.createdAt) ? a : b)).createdAt) : null;

  const select = useCallback(
    (caseKey: string | null) => {
      const next = new URLSearchParams(params);
      if (caseKey) next.set("case", caseKey);
      else next.delete("case");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const onDecided = useCallback(
    async (decidedId: string) => {
      // open the item that followed the decided one, as it stood before the queue refreshed
      const i = items.findIndex((x) => x.caseId === decidedId);
      const following = items[i + 1] ?? items[i - 1] ?? null;
      await props.invalidateOnDecided?.();
      select(following ? following.caseKey : null);
    },
    [items, props, select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = reviewKeyAction(e, false);
      if (!a) return;
      if (a.type === "move") {
        e.preventDefault();
        const id = moveSelection(items, active?.caseId ?? null, a.delta);
        const hit = items.find((x) => x.caseId === id);
        if (hit) select(hit.caseKey);
      } else if (a.type === "help") {
        setHelpOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, active, select]);

  if (queue.isLoading) return <PageSkeleton variant="list" />;
  // on a phone the list and the detail are two screens: the detail shows when the URL names an item
  const detailOnly = wanted !== null && active !== null;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-normal text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {all.length} waiting{newCount ? ` · ${newCount} new` : ""}
          {oldest ? ` · oldest ${oldest}` : ""}
        </p>
        <span className="flex-1" />
        {canDecide ? (
          <span role="group" aria-label="Whose items" className="flex gap-1">
            <Button type="button" size="sm" variant={mine ? "outline" : "ghost"} aria-pressed={mine} onClick={() => setMine(true)}>Mine</Button>
            <Button type="button" size="sm" variant={mine ? "ghost" : "outline"} aria-pressed={!mine} onClick={() => setMine(false)}>All</Button>
          </span>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => setSort(sort === "oldest" ? "newest" : "oldest")}>
          {sort === "oldest" ? "Oldest first" : "Newest first"}
        </Button>
        {metrics ? (
          <Button type="button" size="sm" variant="ghost" aria-expanded={showMetrics} onClick={() => setShowMetrics((v) => !v)}>
            <ChartBar className="h-4 w-4" /> Metrics
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)} aria-label="Keyboard shortcuts">?</Button>
      </header>

      {helpOpen ? (
        <p className="border border-border bg-muted/40 p-2 text-xs text-muted-foreground" role="note">
          <kbd>j</kbd>/<kbd>k</kbd> next and previous · <kbd>a</kbd> approve · <kbd>r</kbd> request changes · <kbd>x</kbd> reject · <kbd>?</kbd> this help. Keys do nothing while you type.
        </p>
      ) : null}
      {showMetrics && metrics ? <div className="border border-border">{metrics}</div> : null}
      {queue.error ? <p className="text-sm text-amber-700 dark:text-amber-300">The queue could not be loaded. Try again in a moment.</p> : null}

      {items.length === 0 ? (
        <EmptyState icon={emptyIcon} message={mine && all.length ? `Nothing here is yours to decide.` : `No ${noun} waiting.`} description={emptyHint} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ul className={`space-y-1 ${detailOnly ? "hidden lg:block" : ""}`} aria-label={`${noun} waiting`}>
            {items.map((item) => {
              const line = statusLine(item);
              const Icon = TONE_ICON[line.icon];
              const sub = subLine?.(item);
              const selected = item.caseId === active?.caseId;
              return (
                <li key={item.caseId}>
                  <button
                    type="button"
                    onClick={() => select(item.caseKey)}
                    aria-current={selected}
                    className={`w-full border-l-2 p-2 text-left transition-colors hover:bg-accent/50 ${selected ? "border-primary bg-accent/40" : "border-transparent"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{item.caseKey}</span>
                        {isNewSince(item.proposedAt, seenAt) ? <span className="text-xs font-medium text-foreground">New</span> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{ageLabel(item.createdAt)}</span>
                    </span>
                    <span className="block text-sm font-medium text-foreground">{item.title}</span>
                    {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
                    <span className={`flex items-center gap-1 text-xs ${TONE_CLASS[line.tone]}`}>
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {line.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className={`min-w-0 ${detailOnly ? "" : "hidden lg:block"}`}>
            {detailOnly ? (
              <Button type="button" variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={() => select(null)}>
                <ArrowLeft className="h-4 w-4" /> Back to the list
              </Button>
            ) : null}
            {active ? renderDetail(active, { onDecided }) : null}
          </div>
        </div>
      )}
    </div>
  );
}
