import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Columns3, KanbanSquare, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useSearchParams } from "@/lib/router";
import { devflowBoardApi, type BoardColumn } from "../api/devflowBoard";
import { BoardColumns } from "../components/requests/BoardColumns";
import { ActiveFilters, DisplayMenu, FilterMenu, SearchBox, ViewsMenu } from "../components/requests/BoardToolbar";
import { STAGE_ICON } from "../components/requests/labels";
import { RequestChips, cardHref } from "../components/requests/RequestCard";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  DEFAULT_DISPLAY,
  boardColumns,
  deleteView,
  filterCards,
  filterFromParams,
  filterToParams,
  readDisplay,
  readViews,
  saveView,
  sortCards,
  toggleCollapsed,
  writeDisplay,
  type BoardDisplay,
  type BoardFilter,
  type BoardLayout,
  type SavedView,
} from "../lib/requests-board";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

// DevFlow Requests: every request of the company by stage, as a board or a list (openspec change add-request-board, D6/D7).
// Read-only: a stage changes only through the review pages, so a card leads to the page where the request waits.
// The filter lives in the URL so a board can be shared as a link; display settings and views stay in this browser.

export function Requests() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const { filter, layout } = useMemo(() => filterFromParams(params), [params]);
  const [display, setDisplayState] = useState<BoardDisplay>(DEFAULT_DISPLAY);
  const [views, setViews] = useState<SavedView[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Requests" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  useEffect(() => {
    if (!selectedCompanyId) return;
    setViews(readViews(selectedCompanyId));
    setDisplayState(readDisplay(selectedCompanyId));
  }, [selectedCompanyId]);

  const update = useCallback((next: BoardFilter, nextLayout: BoardLayout = layout) => setParams(filterToParams(next, nextLayout), { replace: true }), [layout, setParams]);
  const setDisplay = (d: BoardDisplay) => {
    setDisplayState(d);
    if (selectedCompanyId) writeDisplay(selectedCompanyId, d);
  };

  const query = useQuery({
    queryKey: queryKeys.devflowBoard.board(selectedCompanyId ?? "none"),
    queryFn: () => devflowBoardApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const cards = query.data?.cards ?? [];
  const columns = query.data?.columns ?? [];
  const shown = useMemo(() => filterCards(cards, filter), [cards, filter]);
  const groups = useMemo(() => boardColumns(columns, shown, filter, display), [columns, shown, filter, display]);

  if (!selectedCompanyId) return <EmptyState icon={KanbanSquare} message="Select an organization to see its requests." />;
  if (query.isLoading) return <PageSkeleton variant="list" />;
  if (query.error || !query.data) return <EmptyState icon={AlertTriangle} message="The requests could not be loaded. Try again in a moment." />;
  if (columns.length === 0) return <EmptyState icon={KanbanSquare} message="This organization has no dev-request pipeline yet." description="Create it on the Setup page." />;

  const open = cards.filter((c) => !c.terminal).length;
  const mine = cards.filter((c) => c.waitingFor === "person" && c.canDecide).length;
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-normal text-foreground">Requests</h1>
        <p className="text-sm text-muted-foreground">
          {open} open
          {mine ? (
            <>
              {" · "}
              <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => update({ ...filter, waiting: ["me"] })}>
                {mine} waiting for you
              </button>
            </>
          ) : null}
          {shown.length !== cards.length ? ` · ${shown.length} shown` : ""}
        </p>
        <span className="flex-1" />
        <SearchBox value={filter.text} onChange={(text) => update({ ...filter, text })} />
        <FilterMenu cards={cards} columns={columns} filter={filter} onChange={(f) => update(f)} />
        <DisplayMenu display={display} onChange={setDisplay} />
        <ViewsMenu
          views={views}
          onApply={(v) => {
            update(v.filter, v.layout);
            if (v.display) setDisplay(v.display);
          }}
          onDelete={(name) => setViews(deleteView(selectedCompanyId, name))}
          onSave={(name) => {
            const next = saveView(selectedCompanyId, { name, layout, filter, display });
            if (next) setViews(next);
            return !!next;
          }}
        />
        <span role="group" aria-label="Layout" className="inline-flex rounded-md border border-border p-0.5">
          {(
            [
              ["kanban", Columns3, "Board"],
              ["list", List, "List"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={layout === key}
              onClick={() => update(filter, key)}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-sm", layout === key ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </span>
      </header>

      <ActiveFilters filter={filter} columns={columns} onChange={(f) => update(f)} />

      {layout === "kanban" ? (
        <BoardColumns groups={groups} props={display.props} onToggle={(key) => setDisplay(toggleCollapsed(display, columns, key))} />
      ) : (
        <ListView cards={sortCards(shown, display.sort)} columns={columns} display={display} />
      )}
    </div>
  );
}

function ListView({ cards, columns, display }: { cards: ReturnType<typeof sortCards>; columns: readonly BoardColumn[]; display: BoardDisplay }) {
  if (cards.length === 0) return <EmptyState icon={KanbanSquare} message="No request matches these filters." />;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {cards.map((card) => {
        const column = columns.find((c) => c.key === card.stageKey);
        const stage = column ? STAGE_ICON[column.kind] : null;
        return (
          <li key={card.caseId} className="relative flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 transition-colors hover:bg-accent/40">
            <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{card.caseKey}</span>
            <Link to={cardHref(card)} className="min-w-48 flex-1 truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {card.title}
            </Link>
            {column && stage ? (
              <span className="inline-flex w-36 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <stage.Icon className={cn("size-3.5", stage.tone)} aria-hidden /> <span className="truncate">{column.name}</span>
              </span>
            ) : null}
            <RequestChips card={card} props={display.props} />
          </li>
        );
      })}
    </ul>
  );
}
