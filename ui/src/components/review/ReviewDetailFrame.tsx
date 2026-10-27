import { useState, type ReactNode } from "react";

// The detail side of the shared review workspace: a header, a row of sections (one shown at a time, the first by default),
// and the decision bar pinned under them so it is always in reach (openspec change redesign-review-queues).

export interface DetailSection {
  id: string;
  label: string;
  count?: number;
  /** a section that needs attention shows a dot beside its label */
  attention?: boolean;
  content: ReactNode;
}

export function ReviewDetailFrame({ header, sections, bar }: { header: ReactNode; sections: DetailSection[]; bar: ReactNode }) {
  const [openId, setOpenId] = useState(sections[0]?.id ?? "");
  const current = sections.find((s) => s.id === openId) ?? sections[0];
  return (
    <div className="flex min-h-0 flex-col border border-border">
      <div className="space-y-2 border-b border-border p-3">
        {header}
        <nav className="flex flex-wrap gap-4" aria-label="Sections">
          {sections.map((s) => {
            const selected = s.id === current?.id;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => setOpenId(s.id)}
                className={`border-b-2 pb-1 text-sm ${selected ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {s.label}
                {s.count !== undefined ? <span className="ml-1 text-xs text-muted-foreground">{s.count}</span> : null}
                {s.attention ? <span className="ml-1 text-destructive" aria-label="needs attention">●</span> : null}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="max-h-[calc(100vh-18rem)] min-h-40 overflow-y-auto p-3">{current?.content}</div>
      <div className="sticky bottom-0">{bar}</div>
    </div>
  );
}
