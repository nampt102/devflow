import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bot, Columns3, KanbanSquare, List, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Link } from "@/lib/router";
import { devflowBoardApi, type BoardCard } from "../api/devflowBoard";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  EMPTY_FILTER,
  activeFilterCount,
  deleteView,
  filterCards,
  groupByColumn,
  optionsOf,
  readViews,
  saveView,
  type BoardFilter,
  type BoardLayout,
  type SavedView,
} from "../lib/requests-board";
import { ageLabel, agoLabel } from "../lib/triage-review";

// DevFlow Requests: every request of the company by stage, as columns or a list. Read-only: a stage changes only through the
// review pages, so a card leads to the page where the request waits (or to its history). Views are saved in this browser.

const PICK = "h-9 border border-input bg-background px-2 text-sm text-foreground";

export function Requests() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [layout, setLayout] = useState<BoardLayout>("kanban");
  const [filter, setFilter] = useState<BoardFilter>(EMPTY_FILTER);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Requests" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    if (selectedCompanyId) setViews(readViews(selectedCompanyId));
  }, [selectedCompanyId]);

  const query = useQuery({
    queryKey: queryKeys.devflowBoard.board(selectedCompanyId ?? "none"),
    queryFn: () => devflowBoardApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const cards = query.data?.cards ?? [];
  const shown = useMemo(() => filterCards(cards, filter), [cards, filter]);
  const columns = query.data?.columns ?? [];
  const groups = useMemo(() => groupByColumn(columns, shown), [columns, shown]);
  const set = <K extends keyof BoardFilter>(key: K, value: BoardFilter[K]) => setFilter((f) => ({ ...f, [key]: value }));

  if (!selectedCompanyId) return <EmptyState icon={KanbanSquare} message="Select an organization to see its requests." />;
  if (query.isLoading) return <PageSkeleton variant="list" />;
  if (query.error || !query.data) return <EmptyState icon={AlertTriangle} message="The requests could not be loaded. Try again in a moment." />;
  if (columns.length === 0) return <EmptyState icon={KanbanSquare} message="This organization has no dev-request pipeline yet." description="Create it on the Setup page." />;

  const filters = activeFilterCount(filter);
  const open = cards.filter((c) => !c.terminal).length;
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold tracking-normal text-foreground">Requests</h1>
        <p className="text-sm text-muted-foreground">
          {open} open{filters ? ` · ${shown.length} shown` : ""}. Stages change only on the review pages.
        </p>
        <span className="flex-1" />
        <span role="group" aria-label="Layout" className="flex gap-1">
          <Button type="button" size="sm" variant={layout === "kanban" ? "outline" : "ghost"} aria-pressed={layout === "kanban"} onClick={() => setLayout("kanban")}>
            <Columns3 className="h-4 w-4" /> Columns
          </Button>
          <Button type="button" size="sm" variant={layout === "list" ? "outline" : "ghost"} aria-pressed={layout === "list"} onClick={() => setLayout("list")}>
            <List className="h-4 w-4" /> List
          </Button>
        </span>
      </header>

      <section className="flex flex-wrap items-center gap-2" aria-label="Filters">
        <span className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search title or key" placeholder="Search" className="pl-8" value={filter.text} onChange={(e) => set("text", e.target.value)} />
        </span>
        <Pick label="Priority" value={filter.priority} options={optionsOf(cards, (c) => c.priority)} onChange={(v) => set("priority", v)} />
        <Pick label="Type" value={filter.classification} options={optionsOf(cards, (c) => c.classification)} onChange={(v) => set("classification", v)} />
        <Pick label="System" value={filter.system} options={optionsOf(cards, (c) => c.systems)} onChange={(v) => set("system", v)} />
        <Pick label="Requester" value={filter.requester} options={optionsOf(cards, (c) => c.requesterName)} onChange={(v) => set("requester", v)} />
        <Button type="button" size="sm" variant={filter.mine ? "outline" : "ghost"} aria-pressed={filter.mine} onClick={() => set("mine", !filter.mine)}>
          Mine to decide
        </Button>
        {filters ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
            Clear ({filters})
          </Button>
        ) : null}
      </section>

      <section className="flex flex-wrap items-center gap-2" aria-label="Saved views">
        <span className="text-xs text-muted-foreground">Views in this browser:</span>
        {views.length === 0 ? <span className="text-xs text-muted-foreground">none yet</span> : null}
        {views.map((v) => (
          <span key={v.name} className="inline-flex items-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setFilter(v.filter);
                setLayout(v.layout);
              }}
            >
              {v.name}
            </Button>
            <Button type="button" size="sm" variant="ghost" aria-label={`Delete view ${v.name}`} onClick={() => setViews(deleteView(selectedCompanyId, v.name))}>
              ×
            </Button>
          </span>
        ))}
        <Input aria-label="Name for a new view" placeholder="Save current as…" className="w-48" value={viewName} onChange={(e) => setViewName(e.target.value)} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!viewName.trim()}
          onClick={() => {
            const next = saveView(selectedCompanyId, { name: viewName, layout, filter });
            if (next) {
              setViews(next);
              setViewName("");
            }
          }}
        >
          Save view
        </Button>
      </section>

      {layout === "kanban" ? (
        <div className="flex gap-3 overflow-x-auto pb-2" aria-label="Requests by stage">
          {groups.map(({ column, cards: list }) => (
            <section key={column.key} className={`shrink-0 space-y-2 ${column.kind === "done" || column.kind === "cancelled" ? "w-56" : "w-64"}`} aria-label={column.name}>
              <h2 className="flex items-center justify-between text-sm font-medium text-foreground">
                {column.name}
                <span className="text-xs text-muted-foreground">{list.length}</span>
              </h2>
              {list.length === 0 ? <p className="text-xs text-muted-foreground">Empty</p> : null}
              <ul className="space-y-2">
                {list.map((card) => (
                  <li key={card.caseId}>
                    <CardView card={card} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {shown.length === 0 ? <li className="p-3 text-sm text-muted-foreground">No request matches these filters.</li> : null}
          {[...shown]
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .map((card) => (
              <li key={card.caseId} className="p-2">
                <CardView card={card} row stageName={columns.find((c) => c.key === card.stageKey)?.name} />
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function Pick({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select aria-label={label} className={PICK} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label}: any</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function CardView({ card, row, stageName }: { card: BoardCard; row?: boolean; stageName?: string }) {
  const waiting = card.waitingFor === "person" ? { Icon: User, text: card.canDecide ? "Waiting for you" : "Waiting for a person" } : card.waitingFor === "agent" ? { Icon: Bot, text: "Waiting for the agent" } : null;
  return (
    <div className={`space-y-1 border border-border p-2 ${row ? "flex flex-wrap items-center gap-x-4" : ""}`}>
      <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{card.caseKey}</span>
        <span title={`In this stage since ${new Date(card.stageEnteredAt).toLocaleString()}`}>{ageLabel(card.stageEnteredAt)} here</span>
      </p>
      <p className="text-sm font-medium text-foreground">
        {card.reviewPage ? (
          <Link to={`/${card.reviewPage}?case=${card.caseKey}`} className="underline-offset-2 hover:underline">
            {card.title}
          </Link>
        ) : (
          card.title
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {[stageName, card.priority, card.classification, card.systems.join(", "), card.requesterName].filter(Boolean).join(" · ")}
      </p>
      {waiting ? (
        <p className={`flex items-center gap-1 text-xs ${card.canDecide ? "font-medium text-foreground" : "text-muted-foreground"}`}>
          <waiting.Icon className="h-3.5 w-3.5" aria-hidden /> {waiting.text}
        </p>
      ) : null}
      {card.lastFailure ? (
        <p className="flex items-center gap-1 text-xs text-destructive" role="status">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Agent problem{card.lastFailure.kind ? `: ${card.lastFailure.kind}` : ""} · {agoLabel(card.lastFailure.at)}
        </p>
      ) : null}
      <p className="text-xs">
        <Link to={`/requests/${card.caseKey}`} className="text-muted-foreground underline underline-offset-2">
          History
        </Link>
      </p>
    </div>
  );
}
