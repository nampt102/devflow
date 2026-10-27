import { useEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { REJECT_CONFIRM_TEXT, reviewKeyAction, type ReviewDecision } from "../../lib/review-workspace";

// The decision bar of the shared review workspace (openspec change redesign-review-queues): pinned at the bottom of the detail,
// secondary actions on the left, Approve on the right (DESIGN.md footers). The reason box opens only for Request changes
// and Reject; Reject asks for confirmation. a / r / x do the same as the buttons, except while typing or with a dialog open.

export interface DecisionBarProps {
  stage: keyof typeof REJECT_CONFIRM_TEXT;
  pending: boolean;
  /** why a decision cannot be sent now (no access, missing reason...), or null */
  blocker: (decision: ReviewDecision, reason: string) => string | null;
  onDecide: (decision: ReviewDecision, reason: string) => void;
  /** a line above the buttons, for example the access notice */
  notice?: string | null;
  /** the Approve button text when it says more than "Approve" (e.g. "Approve with 2 corrections") */
  approveLabel?: string;
  /** one more secondary action, placed after Reject (Triage: Snooze) */
  extra?: React.ReactNode;
}

const LABEL: Record<ReviewDecision, string> = { approve: "Approve", request_changes: "Request changes", reject: "Reject" };
const PLACEHOLDER: Record<"request_changes" | "reject", string> = {
  request_changes: "What should change? The agent or the requester reads this.",
  reject: "Why is this being rejected?",
};

export function DecisionBar({ stage, pending, blocker, onDecide, notice, approveLabel, extra }: DecisionBarProps) {
  // which decision the reason box is open for; Approve needs no reason
  const [open, setOpen] = useState<"request_changes" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  const choose = (decision: ReviewDecision) => {
    if (pending) return;
    if (decision === "approve") {
      if (!blocker("approve", reason)) onDecide("approve", reason);
      return;
    }
    if (open !== decision) {
      setOpen(decision);
      return;
    }
    // second press with a reason: send (Reject through the confirmation)
    if (blocker(decision, reason)) return;
    if (decision === "reject") setConfirmReject(true);
    else onDecide(decision, reason);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = reviewKeyAction(e, confirmReject);
      if (action?.type !== "decide") return;
      e.preventDefault();
      choose(action.decision);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const reasonBlocker = open ? blocker(open, reason) : null;
  return (
    <div className="space-y-2 border-t border-border bg-card p-3">
      {notice ? <p className="text-sm text-amber-700 dark:text-amber-300" role="status">{notice}</p> : null}
      {open ? (
        <div className="space-y-1">
          <label htmlFor="review-reason" className="text-xs font-medium text-muted-foreground">
            Reason for {open === "reject" ? "rejecting" : "requesting changes"}
          </label>
          <Textarea id="review-reason" ref={box} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={PLACEHOLDER[open]} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={() => choose("request_changes")} aria-keyshortcuts="r">
            <RotateCcw className="h-4 w-4" /> {open === "request_changes" ? "Send changes request" : "Request changes"}
            <kbd className="ml-1 text-xs text-muted-foreground">r</kbd>
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => choose("reject")} aria-keyshortcuts="x" className="text-destructive">
            <X className="h-4 w-4" /> {open === "reject" ? "Reject…" : "Reject"}
            <kbd className="ml-1 text-xs text-muted-foreground">x</kbd>
          </Button>
          {extra}
          {open ? (
            <Button type="button" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          ) : null}
        </div>
        <Button type="button" disabled={pending || !!blocker("approve", reason)} title={blocker("approve", reason) ?? undefined} onClick={() => choose("approve")} aria-keyshortcuts="a">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {approveLabel ?? "Approve"}
          <kbd className="ml-1 text-xs opacity-70">a</kbd>
        </Button>
      </div>
      {open && reasonBlocker && reason.length > 0 ? <p className="text-xs text-destructive">{reasonBlocker}</p> : null}

      <AlertDialog open={confirmReject} onOpenChange={setConfirmReject}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this request?</AlertDialogTitle>
            <AlertDialogDescription>{REJECT_CONFIRM_TEXT[stage]} This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReject(false);
                onDecide("reject", reason);
              }}
            >
              {LABEL.reject}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
