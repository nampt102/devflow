import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Bookmark, Check, Clock, EyeOff, ListFilter, Search, Server, SlidersHorizontal, Trash2, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PriorityIcon } from "@/components/PriorityIcon";
import type { BoardCard, BoardColumn } from "../../api/devflowBoard";
import {
  AGE_KEYS,
  CARD_PROPS,
  EMPTY_FILTER,
  WAITING_KEYS,
  activeFilterCount,
  countBy,
  optionsOf,
  toggleValue,
  waitingOf,
  type AgeKey,
  type BoardDisplay,
  type BoardFilter,
  type CardSort,
  type ListFilterKey,
  type SavedView,
} from "../../lib/requests-board";
import { cn } from "../../lib/utils";
import { AGE_LABEL, PROP_LABEL, SORT_LABEL, STAGE_ICON, TYPE_ICON, WAITING_LABEL, capitalize, priorityIconKey } from "./labels";

// The toolbar of the Requests board: search, a Filters menu (several values per field, with counts), Display settings,
// saved views, and the active filters as removable chips.

type Option = { value: string; label: string; icon?: ReactNode; count: number };

function OptionList({ title, options, selected, onToggle }: { title: string; options: Option[]; selected: readonly string[]; onToggle: (v: string) => void }) {
  if (options.length === 0) return null;
  return (
    <section className="space-y-0.5" aria-label={title}>
      <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{title}</p>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent">
            <Checkbox checked={on} onCheckedChange={() => onToggle(o.value)} aria-label={`${title}: ${o.label}`} />
            {o.icon ? <span className="flex size-4 items-center justify-center text-muted-foreground">{o.icon}</span> : null}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{o.count}</span>
          </label>
        );
      })}
    </section>
  );
}

function Toggle({ on, onChange, icon, label }: { on: boolean; onChange: (v: boolean) => void; icon: ReactNode; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent">
      <Checkbox checked={on} onCheckedChange={(v) => onChange(v === true)} aria-label={label} />
      <span className="flex size-4 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
    </label>
  );
}

function useFilterOptions(cards: readonly BoardCard[], columns: readonly BoardColumn[]) {
  return useMemo(() => {
    const opts = (pick: (c: BoardCard) => string | null | readonly string[], label: (v: string) => string, icon?: (v: string) => ReactNode): Option[] => {
      const counts = countBy(cards, pick);
      return optionsOf(cards, pick).map((v) => ({ value: v, label: label(v), icon: icon?.(v), count: counts.get(v) ?? 0 }));
    };
    const waiting = countBy(cards, waitingOf);
    const stages = countBy(cards, (c) => c.stageKey);
    return {
      waiting: WAITING_KEYS.map((w) => {
        const { label, Icon } = WAITING_LABEL[w];
        return { value: w, label, icon: <Icon className="size-3.5" />, count: waiting.get(w) ?? 0 };
      }),
      stage: columns.map((c) => {
        const { Icon, tone } = STAGE_ICON[c.kind];
        return { value: c.key, label: c.name, icon: <Icon className={cn("size-3.5", tone)} />, count: stages.get(c.key) ?? 0 };
      }),
      priority: opts((c) => c.priority, capitalize, (v) => <PriorityIcon priority={priorityIconKey(v)} />),
      classification: opts((c) => c.classification, capitalize, (v) => {
        const I = TYPE_ICON[v];
        return I ? <I className="size-3.5" /> : null;
      }),
      system: opts((c) => c.systems, (v) => v, () => <Server className="size-3.5" />),
      requester: opts((c) => c.requesterName, (v) => v, () => <User className="size-3.5" />),
    } satisfies Record<ListFilterKey, Option[]>;
  }, [cards, columns]);
}

const GROUPS: Array<{ key: ListFilterKey; title: string }> = [
  { key: "waiting", title: "Waiting for" },
  { key: "stage", title: "Stage" },
  { key: "priority", title: "Priority" },
  { key: "classification", title: "Type" },
  { key: "system", title: "System" },
  { key: "requester", title: "Requester" },
];

export function FilterMenu({ cards, columns, filter, onChange }: { cards: readonly BoardCard[]; columns: readonly BoardColumn[]; filter: BoardFilter; onChange: (f: BoardFilter) => void }) {
  const [find, setFind] = useState("");
  const options = useFilterOptions(cards, columns);
  const count = activeFilterCount({ ...filter, text: "" });
  const q = find.trim().toLowerCase();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant={count ? "secondary" : "outline"}>
          <ListFilter className="size-4" /> Filters
          {count ? <span className="ml-0.5 rounded-sm bg-primary px-1 text-xs font-medium text-primary-foreground tabular-nums">{count}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border p-2">
          <Input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a value…" aria-label="Find a filter value" className="h-8" />
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {GROUPS.map((g) => (
            <OptionList
              key={g.key}
              title={g.title}
              options={q ? options[g.key].filter((o) => o.label.toLowerCase().includes(q)) : options[g.key]}
              selected={filter[g.key]}
              onToggle={(v) => onChange(toggleValue(filter, g.key, v))}
            />
          ))}
          {!q ? (
            <section className="space-y-0.5" aria-label="More">
              <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Time in stage</p>
              {AGE_KEYS.map((a) => (
                <label key={a} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent">
                  <Checkbox checked={filter.age === a} onCheckedChange={(v) => onChange({ ...filter, age: v === true ? a : ("" as AgeKey) })} aria-label={`Time in stage: ${AGE_LABEL[a]}`} />
                  <span className="flex size-4 items-center justify-center text-muted-foreground"><Clock className="size-3.5" /></span>
                  <span className="flex-1">{AGE_LABEL[a]}</span>
                </label>
              ))}
              <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Other</p>
              <Toggle on={filter.failing} onChange={(v) => onChange({ ...filter, failing: v })} icon={<AlertTriangle className="size-3.5" />} label="Agent problem" />
              <Toggle on={filter.hideClosed} onChange={(v) => onChange({ ...filter, hideClosed: v })} icon={<EyeOff className="size-3.5" />} label="Hide done and cancelled" />
            </section>
          ) : null}
        </div>
        {count ? (
          <div className="border-t border-border p-1">
            <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={() => onChange({ ...EMPTY_FILTER, text: filter.text })}>
              <X className="size-4" /> Clear filters
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function DisplayMenu({ display, onChange }: { display: BoardDisplay; onChange: (d: BoardDisplay) => void }) {
  const toggleProp = (p: (typeof CARD_PROPS)[number]) =>
    onChange({ ...display, props: display.props.includes(p) ? display.props.filter((x) => x !== p) : CARD_PROPS.filter((x) => x === p || display.props.includes(x)) });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <SlidersHorizontal className="size-4" /> Display
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Order in a column</p>
          <div className="grid gap-1" role="radiogroup" aria-label="Order in a column">
            {(Object.keys(SORT_LABEL) as CardSort[]).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={display.sort === s}
                onClick={() => onChange({ ...display, sort: s })}
                className={cn("flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", display.sort === s ? "bg-accent font-medium text-foreground" : "text-foreground")}
              >
                {SORT_LABEL[s]}
                {display.sort === s ? <Check className="size-4" aria-hidden /> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Shown on cards</p>
          <div className="flex flex-wrap gap-1.5">
            {CARD_PROPS.map((p) => {
              const on = display.props.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleProp(p)}
                  className={cn("h-7 rounded-md border px-2 text-xs transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                >
                  {PROP_LABEL[p]}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <Checkbox checked={display.showEmpty} onCheckedChange={(v) => onChange({ ...display, showEmpty: v === true })} />
          Show empty columns
        </label>
      </PopoverContent>
    </Popover>
  );
}

export function ViewsMenu({ views, onApply, onDelete, onSave }: { views: SavedView[]; onApply: (v: SavedView) => void; onDelete: (name: string) => void; onSave: (name: string) => boolean }) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Bookmark className="size-4" /> Views
          {views.length ? <span className="text-xs text-muted-foreground tabular-nums">{views.length}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="max-h-64 overflow-y-auto p-1">
          {views.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">No saved views yet. Views are kept in this browser.</p> : null}
          {views.map((v) => (
            <div key={v.name} className="group flex items-center rounded-md hover:bg-accent">
              <button
                type="button"
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm text-foreground"
                onClick={() => {
                  onApply(v);
                  setOpen(false);
                }}
              >
                {v.name}
              </button>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Delete view ${v.name}`} className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onDelete(v.name)}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <form
          className="flex gap-2 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (onSave(name)) setName("");
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Save current as…" aria-label="Name for a new view" className="h-8" />
          <Button type="submit" size="sm" disabled={!name.trim()} className="h-8">
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input aria-label="Search title or key" placeholder="Search requests" className="h-9 w-56 pl-8" value={value} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

function ActiveChip({ label, values, onRemove }: { label: string; values: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background pl-2 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-48 truncate font-medium text-foreground">{values}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${label} filter`} className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </span>
  );
}

export function ActiveFilters({ filter, columns, onChange }: { filter: BoardFilter; columns: readonly BoardColumn[]; onChange: (f: BoardFilter) => void }) {
  const chips: Array<{ key: string; label: string; values: string; clear: Partial<BoardFilter> }> = [];
  const names: Record<ListFilterKey, (v: string) => string> = {
    waiting: (v) => WAITING_LABEL[v as keyof typeof WAITING_LABEL]?.label ?? v,
    stage: (v) => columns.find((c) => c.key === v)?.name ?? v,
    priority: capitalize,
    classification: capitalize,
    system: (v) => v,
    requester: (v) => v,
  };
  for (const g of GROUPS) {
    if (filter[g.key].length) chips.push({ key: g.key, label: g.title, values: filter[g.key].map(names[g.key]).join(", "), clear: { [g.key]: [] } });
  }
  if (filter.age) chips.push({ key: "age", label: "Time in stage", values: AGE_LABEL[filter.age]!, clear: { age: "" } });
  if (filter.failing) chips.push({ key: "failing", label: "Agent problem", values: "yes", clear: { failing: false } });
  if (filter.hideClosed) chips.push({ key: "closed", label: "Done and cancelled", values: "hidden", clear: { hideClosed: false } });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((c) => (
        <ActiveChip key={c.key} label={c.label} values={c.values} onRemove={() => onChange({ ...filter, ...c.clear })} />
      ))}
      <Button type="button" size="xs" variant="ghost" onClick={() => onChange({ ...EMPTY_FILTER, text: filter.text })}>
        Clear all
      </Button>
    </div>
  );
}
