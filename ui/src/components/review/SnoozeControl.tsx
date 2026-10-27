import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "../../api/client";
import { devflowTriageApi } from "../../api/devflowTriage";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { SNOOZE_PRESETS, backOnLabel, snoozeBlocker, vnDay } from "../../lib/triage-snooze";
import { agoLabel } from "../../lib/triage-review";

// Triage snooze (openspec change add-triage-snooze): hide a request until a day and let it return by itself. The button sits in
// the decision bar; the list of snoozed requests sits under the page header. Neither changes the stage or tells the requester.

export function SnoozeButton({ companyId, caseId, caseKey, version, disabledReason, onSnoozed }: { companyId: string; caseId: string; caseKey: string; version: number; disabledReason: string | null; onSnoozed: (caseId: string) => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(vnDay(7));
  const [note, setNote] = useState("");
  const blocker = snoozeBlocker(day);

  const snooze = useMutation({
    mutationFn: () => devflowTriageApi.snooze(companyId, caseId, { until: day, note: note.trim() || undefined, expectedVersion: version }),
    onSuccess: async () => {
      pushToast({ title: `${caseKey} snoozed`, body: backOnLabel(`${day}T00:00:00+07:00`), tone: "success" });
      setOpen(false);
      setNote("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.snoozed(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.count(companyId) });
      onSnoozed(caseId);
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      pushToast({ title: conflict ? "Already handled" : "Not snoozed", body: conflict ? "Someone else decided this request or it changed. The queue was refreshed." : error instanceof Error ? error.message : "Try again.", tone: "error" });
      queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.queue(companyId) });
    },
  });

  return (
    <>
      <Button type="button" variant="outline" disabled={!!disabledReason} title={disabledReason ?? "Hide until a day you choose"} onClick={() => setOpen(true)}>
        <AlarmClock className="h-4 w-4" /> Snooze
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Snooze {caseKey}</DialogTitle>
            <DialogDescription>The request leaves the queue and comes back by itself at the start of that day. Its stage does not change and the requester is not told.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {SNOOZE_PRESETS.map((p) => (
                <Button key={p.label} type="button" size="sm" variant={day === vnDay(p.days) ? "default" : "outline"} onClick={() => setDay(vnDay(p.days))}>
                  {p.label}
                </Button>
              ))}
            </div>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Back on</span>
              <Input type="date" value={day} min={vnDay(1)} max={vnDay(90)} onChange={(e) => setDay(e.target.value)} />
              {blocker ? <span className="block text-xs text-destructive" role="alert">{blocker}</span> : null}
            </label>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Note for the team (optional)</span>
              <Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What are we waiting for?" />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!!blocker || snooze.isPending} onClick={() => snooze.mutate()}>
              {snooze.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlarmClock className="h-4 w-4" />} Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The requests hidden for now, with a way to bring one back early. */
export function SnoozedList({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: queryKeys.devflowTriage.snoozed(companyId), queryFn: () => devflowTriageApi.snoozed(companyId), refetchInterval: 60_000, retry: false });
  const items = query.data?.items ?? [];
  const unsnooze = useMutation({
    mutationFn: (caseId: string) => devflowTriageApi.unsnooze(companyId, caseId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.snoozed(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.queue(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.devflowTriage.count(companyId) });
    },
    onError: (error) => pushToast({ title: "Could not bring it back", body: error instanceof Error ? error.message : "Try again.", tone: "error" }),
  });
  if (items.length === 0) return null;
  return (
    <section className="border border-border" aria-label="Snoozed requests">
      <button type="button" className="flex w-full items-center gap-2 p-2 text-left text-sm font-medium text-foreground" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <AlarmClock className="h-4 w-4" aria-hidden /> Snoozed ({items.length})
      </button>
      {open ? (
        <ul className="divide-y divide-border border-t border-border">
          {items.map((i) => (
            <li key={i.caseId} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
              <span>
                <span className="font-mono text-xs text-muted-foreground">{i.caseKey}</span> <span className="text-foreground">{i.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {backOnLabel(i.snoozedUntil)}
                  {i.snoozedByName ? ` · snoozed by ${i.snoozedByName}` : ""}
                  {i.note ? ` · ${i.note}` : ""} · from {i.requesterName}, {agoLabel(i.createdAt)}
                </span>
              </span>
              <Button type="button" size="sm" variant="outline" disabled={unsnooze.isPending} onClick={() => unsnooze.mutate(i.caseId)}>
                Bring back now
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
