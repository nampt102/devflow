import { AlertTriangle, Clock, History, MoreHorizontal, Server, SquareArrowOutUpRight, User } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "@/lib/router";
import { PriorityIcon } from "@/components/PriorityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { BoardCard } from "../../api/devflowBoard";
import type { CardProp } from "../../lib/requests-board";
import { ageLabel, agoLabel } from "../../lib/triage-review";
import { cn } from "../../lib/utils";
import { TYPE_ICON, WAITING_LABEL, capitalize, priorityIconKey } from "./labels";

// One request on the Requests board: key, title and a row of small chips. The whole card opens the page where the request
// waits (its review page, else its history); the menu offers both. Nothing here changes a request.

function Chip({ children, title, tone = "default" }: { children: ReactNode; title?: string; tone?: "default" | "strong" | "danger" }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-md border px-1.5 text-xs whitespace-nowrap",
        tone === "default" && "border-border bg-background text-muted-foreground",
        tone === "strong" && "border-primary/40 bg-primary/10 font-medium text-foreground",
        tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

export function cardHref(card: BoardCard) {
  return card.reviewPage ? `/${card.reviewPage}?case=${encodeURIComponent(card.caseKey)}` : `/requests/${encodeURIComponent(card.caseKey)}`;
}

export function RequestChips({ card, props }: { card: BoardCard; props: readonly CardProp[] }) {
  const show = (p: CardProp) => props.includes(p);
  const TypeIcon = card.classification ? TYPE_ICON[card.classification] : undefined;
  const waiting = card.waitingFor === "person" ? WAITING_LABEL[card.canDecide ? "me" : "person"] : card.waitingFor === "agent" ? WAITING_LABEL.agent : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {card.lastFailure ? (
        <Chip tone="danger" title={`Last agent run failed ${agoLabel(card.lastFailure.at)}`}>
          <AlertTriangle className="size-3" aria-hidden /> {card.lastFailure.kind ? capitalize(card.lastFailure.kind) : "Agent problem"}
        </Chip>
      ) : null}
      {waiting ? (
        <Chip tone={card.waitingFor === "person" && card.canDecide ? "strong" : "default"}>
          <waiting.Icon className="size-3" aria-hidden /> {card.waitingFor === "person" && card.canDecide ? "You decide" : card.waitingFor === "person" ? "Person" : "Agent"}
        </Chip>
      ) : null}
      {show("priority") && card.priority ? (
        <Chip title={`Priority: ${card.priority}`}>
          <PriorityIcon priority={priorityIconKey(card.priority)} className="[&_svg]:size-3" /> {capitalize(card.priority)}
        </Chip>
      ) : null}
      {show("classification") && card.classification ? (
        <Chip title={`Type: ${card.classification}`}>
          {TypeIcon ? <TypeIcon className="size-3" aria-hidden /> : null} {capitalize(card.classification)}
        </Chip>
      ) : null}
      {show("systems")
        ? card.systems.map((s) => (
            <Chip key={s} title={`System: ${s}`}>
              <Server className="size-3" aria-hidden /> <span className="truncate">{s}</span>
            </Chip>
          ))
        : null}
      {show("age") && !card.terminal ? (
        <Chip title={`In this stage since ${new Date(card.stageEnteredAt).toLocaleString()}`}>
          <Clock className="size-3" aria-hidden /> {ageLabel(card.stageEnteredAt)}
        </Chip>
      ) : null}
      {show("requester") ? (
        <Chip title={`From ${card.requesterName}`}>
          <User className="size-3" aria-hidden /> <span className="truncate">{card.requesterName}</span>
        </Chip>
      ) : null}
    </div>
  );
}

export function RequestCard({ card, props }: { card: BoardCard; props: readonly CardProp[] }) {
  const navigate = useNavigate();
  return (
    <article
      className={cn(
        "group relative space-y-2 rounded-lg border bg-card p-3 shadow-xs transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-md focus-within:border-foreground/30",
        card.waitingFor === "person" && card.canDecide ? "border-primary/40" : "border-border",
        card.terminal && "opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{card.caseKey}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Actions for ${card.caseKey}`}
            className="relative z-10 -my-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {card.reviewPage ? (
              <DropdownMenuItem onSelect={() => navigate(cardHref(card))}>
                <SquareArrowOutUpRight className="size-4" /> Open review
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => navigate(`/requests/${encodeURIComponent(card.caseKey)}`)}>
              <History className="size-4" /> History
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <h3 className="line-clamp-2 text-sm font-medium text-foreground" title={card.title}>
        {/* the link covers the card so the whole card is one target; the menu sits above it */}
        <Link to={cardHref(card)} className="outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring">
          {card.title}
        </Link>
      </h3>
      <RequestChips card={card} props={props} />
    </article>
  );
}
