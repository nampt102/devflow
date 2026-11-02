import { useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { PreviousRound } from "../../api/devflowBa";
import { agoLabel } from "../../lib/triage-review";

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

/** "Since last round": why the previous proposal was sent back and what changed in the fields a reviewer checks first. */
export function SinceLastRound({ round }: { round: PreviousRound }) {
  return (
    <section className="space-y-1 border border-border bg-muted/40 p-2 text-sm" aria-label="Since last round">
      <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Sent back {agoLabel(round.decidedAt)}
        {round.decidedBy ? ` by ${round.decidedBy}` : ""}
        {round.fromStage === "qa_signoff" ? " from QA sign-off" : ""}
      </p>
      <p className="whitespace-pre-wrap text-foreground">{round.reason}</p>
      {round.changes.length ? (
        <ul className="text-xs text-muted-foreground">
          {round.changes.map((c) => (
            <li key={c.field}>
              {c.field}: <span className="font-mono">{c.before || "none"}</span> → <span className="font-mono text-foreground">{c.after || "none"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No change in the main fields; read the details for what is new.</p>
      )}
    </section>
  );
}

export function ReviewDetailFrame({ header, sections, bar, previousRound }: { header: ReactNode; sections: DetailSection[]; bar: ReactNode; previousRound?: PreviousRound | null }) {
  const [openId, setOpenId] = useState(sections[0]?.id ?? "");
  const current = sections.find((s) => s.id === openId) ?? sections[0];
  return (
    <div className="flex min-h-0 flex-col border border-border lg:sticky lg:top-0 lg:max-h-(--review-detail-max-h)">
      <div className="space-y-2 border-b border-border p-3">
        {header}
        {previousRound ? <SinceLastRound round={previousRound} /> : null}
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
      <div className="min-h-40 flex-1 overflow-y-auto p-3">{current?.content}</div>
      <div className="sticky bottom-0 shrink-0 lg:static">{bar}</div>
    </div>
  );
}
