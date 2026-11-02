import { ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";
import type { BoardCard, BoardColumn } from "../../api/devflowBoard";
import type { CardProp } from "../../lib/requests-board";
import { cn } from "../../lib/utils";
import { STAGE_ICON } from "./labels";
import { RequestCard } from "./RequestCard";

// The Kanban of the Requests board: one column per stage on a muted canvas, each column scrolling on its own under a header
// that stays in place. A collapsed column is a narrow strip with its name written top to bottom.

type Group = { column: BoardColumn; cards: BoardCard[]; collapsed: boolean };

function CollapsedColumn({ group, onToggle }: { group: Group; onToggle: () => void }) {
  const { Icon, tone } = STAGE_ICON[group.column.kind];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Expand ${group.column.name}, ${group.cards.length} requests`}
      aria-expanded={false}
      className="flex w-11 shrink-0 flex-col items-center gap-2 rounded-lg py-2 text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
    >
      <Icon className={cn("size-4", tone)} aria-hidden />
      <span className="devflow-vertical-text text-sm font-medium text-foreground">{group.column.name}</span>
      <span className="text-xs tabular-nums">{group.cards.length}</span>
      <ChevronsLeftRight className="size-3.5" aria-hidden />
    </button>
  );
}

function OpenColumn({ group, props, onToggle }: { group: Group; props: readonly CardProp[]; onToggle: () => void }) {
  const { Icon, tone, hint } = STAGE_ICON[group.column.kind];
  return (
    <section className="flex w-80 shrink-0 flex-col" aria-label={`${group.column.name}, ${group.cards.length} requests`}>
      <header className="flex h-9 items-center gap-2 px-1">
        <span title={hint} className="flex size-5 items-center justify-center">
          <Icon className={cn("size-4", tone)} aria-hidden />
        </span>
        <h2 className="truncate text-sm font-medium text-foreground">{group.column.name}</h2>
        <span className="text-sm text-muted-foreground tabular-nums">{group.cards.length}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Collapse ${group.column.name}`}
          aria-expanded
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground"
        >
          <ChevronsRightLeft className="size-3.5" />
        </button>
      </header>
      <ul className="min-h-24 flex-1 space-y-2 overflow-y-auto px-1 pt-1 pb-3">
        {group.cards.length === 0 ? <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">No requests</li> : null}
        {group.cards.map((card) => (
          <li key={card.caseId}>
            <RequestCard card={card} props={props} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BoardColumns({ groups, props, onToggle }: { groups: Group[]; props: readonly CardProp[]; onToggle: (key: string) => void }) {
  return (
    <div className="min-h-96 flex-1 overflow-x-auto rounded-xl bg-muted/50 p-3" aria-label="Requests by stage">
      <div className="flex h-full w-max min-w-full gap-4">
        {groups.map((g) =>
          g.collapsed ? (
            <CollapsedColumn key={g.column.key} group={g} onToggle={() => onToggle(g.column.key)} />
          ) : (
            <OpenColumn key={g.column.key} group={g} props={props} onToggle={() => onToggle(g.column.key)} />
          ),
        )}
      </div>
    </div>
  );
}
