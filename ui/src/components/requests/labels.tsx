import { Bot, Bug, CircleCheck, CircleDashed, CircleDot, CircleX, MessageSquare, Sparkles, User, UserCheck, type LucideIcon } from "lucide-react";
import type { BoardColumn } from "../../api/devflowBoard";
import type { CardProp, CardSort, WaitingKey } from "../../lib/requests-board";

// Words and icons of the Requests board, shared by the cards, the column headers and the filter menus.

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, " ") : s);

export const STAGE_ICON: Record<BoardColumn["kind"], { Icon: LucideIcon; tone: string; hint: string }> = {
  working: { Icon: CircleDashed, tone: "text-blue-600 dark:text-blue-400", hint: "An agent works on these" },
  review: { Icon: CircleDot, tone: "text-violet-600 dark:text-violet-400", hint: "A person decides these" },
  done: { Icon: CircleCheck, tone: "text-green-600 dark:text-green-400", hint: "Finished" },
  cancelled: { Icon: CircleX, tone: "text-muted-foreground", hint: "Cancelled" },
};

export const WAITING_LABEL: Record<WaitingKey, { label: string; Icon: LucideIcon }> = {
  me: { label: "Waiting for me", Icon: UserCheck },
  person: { label: "Waiting for a person", Icon: User },
  agent: { label: "Agent working", Icon: Bot },
};

export const TYPE_ICON: Record<string, LucideIcon> = { bug: Bug, feature: Sparkles, request: MessageSquare };

/** DevFlow says "urgent" where the shared priority icon says "critical". */
export const priorityIconKey = (p: string) => (p === "urgent" ? "critical" : p);

export const PROP_LABEL: Record<CardProp, string> = { priority: "Priority", classification: "Type", systems: "Systems", age: "Time in stage", requester: "Requester" };

export const SORT_LABEL: Record<CardSort, string> = { stage_oldest: "Longest in stage", stage_newest: "Newest in stage", priority: "Priority" };

export const AGE_LABEL: Record<string, string> = { "1": "1 day or more", "3": "3 days or more", "7": "7 days or more" };
