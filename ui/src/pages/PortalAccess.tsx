import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Link2, Loader2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { accessApi } from "../api/access";
import { devflowAccessApi, type CompanyUser, type PortalInvite } from "../api/devflowAccess";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { accessErrorMessage, copyText, expiryLabel, INVITE_STATUS_LABEL, inviteUrl, isEmail } from "../lib/portal-access";
import { ageLabel } from "../lib/triage-review";

// DevFlow "Portal access" (backlog A-11): who can use the requester portal and the board.
// Secrets (an invite link, a generated password) are shown once, kept only in this page's memory, and
// cleared when the tab changes or the page closes. Nothing is written to browser storage.

type Tab = "invites" | "staff";

function SecretPanel({ title, lines, note, onDone }: { title: string; lines: Array<{ label: string; value: string; secret?: boolean }>; note: string; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="space-y-3 border border-border bg-muted/40 p-3" role="status">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {lines.map((l) => (
        <div key={l.label} className="space-y-1">
          <p className="text-xs text-muted-foreground">{l.label}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all bg-background p-2 font-mono text-sm text-foreground">{l.value}</code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => setCopied((await copyText(l.value)) ? l.label : null)}
              aria-label={`Copy ${l.label}`}
            >
              {copied === l.label ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied === l.label ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ))}
      <p className="text-xs text-amber-700 dark:text-amber-300">{note}</p>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

/** Two-step button: the first click asks, the second does it. */
function ConfirmButton({ label, confirmLabel, onConfirm, busy, variant = "outline" }: { label: string; confirmLabel: string; onConfirm: () => void; busy?: boolean; variant?: "outline" | "destructive" }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex gap-1">
      <Button type="button" size="sm" variant={variant} disabled={busy} onClick={() => { onConfirm(); setAsking(false); }}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {confirmLabel}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

function InvitesTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<{ url: string } | null>(null);
  const list = useQuery({ queryKey: queryKeys.devflowAccess.invites(companyId), queryFn: () => devflowAccessApi.invites(companyId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.devflowAccess.invites(companyId) });

  const create = useMutation({
    mutationFn: () => devflowAccessApi.createInvite(companyId, label),
    onSuccess: (r) => {
      setCreated({ url: inviteUrl(window.location.origin, r.path) });
      setLabel("");
      void refresh();
    },
    onError: (e) => pushToast({ title: "Link not created", body: accessErrorMessage(e), tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => devflowAccessApi.revokeInvite(companyId, id),
    onSuccess: () => {
      pushToast({ title: "Invite link revoked", tone: "success" });
      void refresh();
    },
    onError: (e) => {
      pushToast({ title: "Could not revoke", body: accessErrorMessage(e), tone: "error" });
      void refresh();
    },
  });

  const items = list.data?.items ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Send a link to a business user. They open it, create their account and can file requests in the portal. A link works once and expires after 7 days.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Label (optional, for your own reference)</span>
          <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Accounting team" aria-label="Invite label" />
        </label>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} New invite link
        </Button>
      </form>
      {created ? (
        <SecretPanel
          title="Invite link created"
          lines={[{ label: "Invite link", value: created.url }]}
          note="This link is shown once and cannot be recovered. Send it only to the person it is for; anyone with the link can create an account until it is used or revoked."
          onDone={() => setCreated(null)}
        />
      ) : null}
      {list.isLoading ? (
        <PageSkeleton variant="list" />
      ) : items.length === 0 ? (
        <EmptyState icon={Link2} message="No invite links yet." description="Create one above to onboard a requester." />
      ) : (
        <ul className="divide-y divide-border border border-border" aria-label="Invite links">
          {items.map((i: PortalInvite) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">{i.label || "Untitled invite"}</p>
                <p className="text-xs text-muted-foreground">
                  Created {ageLabel(i.createdAt)} ago
                  {i.status === "pending" ? `, ${expiryLabel(i.expiresAt)}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={i.status === "pending" ? "default" : "outline"}>{INVITE_STATUS_LABEL[i.status]}</Badge>
                {i.status === "pending" ? <ConfirmButton label="Revoke" confirmLabel="Confirm revoke" variant="destructive" busy={revoke.isPending} onConfirm={() => revoke.mutate(i.id)} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StaffTab({ companyId, companyName }: { companyId: string; companyName: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [grant, setGrant] = useState(true);
  const [secret, setSecret] = useState<{ title: string; lines: Array<{ label: string; value: string }> } | null>(null);
  const list = useQuery({ queryKey: queryKeys.devflowAccess.users(companyId), queryFn: () => devflowAccessApi.users(companyId), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.devflowAccess.users(companyId) });

  const create = useMutation({
    mutationFn: () => devflowAccessApi.createUser({ name: name.trim(), email: email.trim(), companyIds: grant ? [companyId] : [] }),
    onSuccess: (r) => {
      setSecret({
        title: `Account created for ${r.user.name}`,
        lines: [
          { label: "Email", value: r.user.email },
          ...(r.password ? [{ label: "Password", value: r.password }] : []),
        ],
      });
      setName("");
      setEmail("");
      void refresh();
    },
    onError: (e) => pushToast({ title: "Account not created", body: accessErrorMessage(e), tone: "error" }),
  });
  const reset = useMutation({
    mutationFn: (u: CompanyUser) => devflowAccessApi.resetPassword(u.id).then((r) => ({ r, u })),
    onSuccess: ({ r, u }) => {
      setSecret({
        title: `New password for ${u.name}`,
        lines: [
          { label: "Email", value: u.email },
          ...(r.password ? [{ label: "Password", value: r.password }] : []),
        ],
      });
      pushToast({ title: "Password reset", body: `${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? "" : "s"} signed out.`, tone: "success" });
    },
    onError: (e) => pushToast({ title: "Password not reset", body: accessErrorMessage(e), tone: "error" }),
  });

  const canSubmit = name.trim().length > 0 && isEmail(email) && !create.isPending;
  const users = list.data?.items ?? [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Create accounts for colleagues who review requests and sign in to this board. The password is generated for you and shown once: give it to them through a private channel.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Full name</span>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="Full name" autoComplete="off" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Email</span>
          <Input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} aria-label="Email" autoComplete="off" />
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2">
          <Checkbox checked={grant} onCheckedChange={(v) => setGrant(v === true)} aria-label={`Give access to ${companyName}`} />
          Give access to {companyName}
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Create account
          </Button>
        </div>
      </form>
      {secret ? (
        <SecretPanel title={secret.title} lines={secret.lines} note="The password is shown once and is not stored anywhere readable. If it is lost, reset it." onDone={() => setSecret(null)} />
      ) : null}
      {list.isLoading ? (
        <PageSkeleton variant="list" />
      ) : list.error ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">The list could not be loaded: {accessErrorMessage(list.error)}</p>
      ) : (
        <ul className="divide-y divide-border border border-border" aria-label="People in this company">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">{u.name}</p>
                <p className="text-xs text-muted-foreground">{u.email}</p>
              </div>
              <div className="flex items-center gap-2">
                {u.membershipRole ? <Badge variant="outline">{u.membershipRole}</Badge> : null}
                {u.status !== "active" ? <Badge variant="secondary">{u.status}</Badge> : null}
                {u.hasPassword ? (
                  <ConfirmButton label="Reset password" confirmLabel="Confirm reset" busy={reset.isPending} onConfirm={() => reset.mutate(u)} />
                ) : (
                  <span className="text-xs text-muted-foreground">no password login</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PortalAccess() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [tab, setTab] = useState<Tab>("invites");

  useEffect(() => {
    setBreadcrumbs([{ label: "Portal access" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  // Account tools are for instance admins (the server enforces it; this only decides what to offer).
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess, queryFn: () => accessApi.getCurrentBoardAccess(), retry: false, staleTime: 30_000 });
  const isAdmin = access.data?.isInstanceAdmin === true || access.data?.source === "local_implicit";

  if (!selectedCompanyId) return <EmptyState icon={KeyRound} message="Select an organization first." />;
  const activeTab: Tab = tab === "staff" && !isAdmin ? "invites" : tab;

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Portal access</h1>
        <p className="mt-1 text-sm text-muted-foreground">Invite requesters to the portal and create accounts for staff.</p>
      </div>
      <div className="flex gap-2" role="tablist" aria-label="Portal access sections">
        <Button type="button" role="tab" aria-selected={activeTab === "invites"} size="sm" variant={activeTab === "invites" ? "default" : "outline"} onClick={() => setTab("invites")}>
          Requester invites
        </Button>
        {isAdmin ? (
          <Button type="button" role="tab" aria-selected={activeTab === "staff"} size="sm" variant={activeTab === "staff" ? "default" : "outline"} onClick={() => setTab("staff")}>
            Staff accounts
          </Button>
        ) : null}
      </div>
      {/* keyed by tab so a secret on screen never survives a tab change */}
      {activeTab === "invites" ? <InvitesTab key="invites" companyId={selectedCompanyId} /> : <StaffTab key="staff" companyId={selectedCompanyId} companyName={selectedCompany?.name ?? "this company"} />}
    </div>
  );
}
