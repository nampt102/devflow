import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Server, ExternalLink, Loader2, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { devflowSystemsApi, type DevflowSystem } from "../api/devflowSystems";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { parseForbiddenPaths, suggestKey, systemsErrorMessage, validateDevSettings, validateSystemForm, type FormErrors, type SystemForm } from "../lib/systems";

// DevFlow "Systems": the repositories a company's requests can be about. The Triage review assigns them to a
// request and the BA agent reads them. The read-only token is typed here, sent once and never shown again;
// it lives only in this page's memory and is cleared after saving.

const EMPTY: SystemForm = { name: "", key: "", repoUrl: "", defaultBranch: "main", docsPath: "docs", description: "" };

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <span className="block text-xs text-destructive" role="alert">{error}</span> : hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function SystemFormView({ companyId, existing, onClose }: { companyId: string; existing: DevflowSystem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const editing = existing !== null;
  const [form, setForm] = useState<SystemForm>(
    existing
      ? { name: existing.name, key: existing.key, repoUrl: existing.repoUrl, defaultBranch: existing.defaultBranch, docsPath: existing.docsPath, description: existing.description }
      : EMPTY,
  );
  const [keyTouched, setKeyTouched] = useState(false);
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [touched, setTouched] = useState(false);
  const [devEnabled, setDevEnabled] = useState(existing?.devEnabled ?? false);
  const [writeToken, setWriteToken] = useState("");
  const [removeWriteToken, setRemoveWriteToken] = useState(false);
  const [testCommand, setTestCommand] = useState(existing?.testCommand ?? "");
  const [forbiddenPaths, setForbiddenPaths] = useState((existing?.forbiddenPaths ?? []).join("\n"));
  const [allowUnprotected, setAllowUnprotected] = useState(existing?.allowUnprotected ?? false);
  const devProblems = () =>
    editing ? validateDevSettings({ devEnabled, testCommand, forbiddenPaths, hasWriteToken: existing?.hasWriteToken ?? false, newWriteToken: writeToken, removeWriteToken }) : {};
  const devErrors = touched ? devProblems() : {};
  const errors: FormErrors = touched ? validateSystemForm(form, { editing }) : {};
  const set = (patch: Partial<SystemForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const trimmed = { ...form, name: form.name.trim(), key: form.key.trim(), repoUrl: form.repoUrl.trim(), defaultBranch: form.defaultBranch.trim(), docsPath: form.docsPath.trim(), description: form.description.trim() };
      if (existing) {
        return devflowSystemsApi.update(companyId, existing.id, {
          name: trimmed.name,
          description: trimmed.description,
          defaultBranch: trimmed.defaultBranch,
          docsPath: trimmed.docsPath,
          ...(token.trim() ? { token: token.trim() } : removeToken ? { token: null } : {}),
          devEnabled,
          testCommand: testCommand.trim() || null,
          forbiddenPaths: parseForbiddenPaths(forbiddenPaths),
          allowUnprotected,
          ...(writeToken.trim() ? { writeToken: writeToken.trim() } : removeWriteToken ? { writeToken: null } : {}),
        });
      }
      return devflowSystemsApi.create(companyId, { ...trimmed, ...(token.trim() ? { token: token.trim() } : {}) });
    },
    onSuccess: () => {
      setToken("");
      setWriteToken("");
      pushToast({ title: editing ? "System updated" : "System added", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.devflowSystems.list(companyId) });
      onClose();
    },
    onError: (e) => pushToast({ title: editing ? "System not updated" : "System not added", body: systemsErrorMessage(e), tone: "error" }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(validateSystemForm(form, { editing })).length > 0 || Object.keys(devProblems()).length > 0 || save.isPending) return;
    save.mutate();
  };

  return (
    <form className="space-y-3 border border-border bg-muted/40 p-4" onSubmit={submit} noValidate aria-label={editing ? "Edit system" : "Add system"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" error={errors.name}>
          <Input
            value={form.name}
            maxLength={200}
            onChange={(e) => set({ name: e.target.value, ...(editing || keyTouched ? {} : { key: suggestKey(e.target.value) }) })}
            placeholder="e.g. HR Portal"
            aria-invalid={Boolean(errors.name)}
          />
        </Field>
        <Field label="Key" hint={editing ? "The key cannot be changed." : "Short name used in the system list, e.g. hr-portal."} error={errors.key}>
          <Input value={form.key} maxLength={63} disabled={editing} onChange={(e) => { setKeyTouched(true); set({ key: e.target.value }); }} aria-invalid={Boolean(errors.key)} />
        </Field>
      </div>
      <Field label="GitHub repository" hint={editing ? "The repository cannot be changed; add a new system instead." : "A plain address like https://github.com/acme/hr-portal."} error={errors.repoUrl}>
        <Input value={form.repoUrl} disabled={editing} onChange={(e) => set({ repoUrl: e.target.value })} placeholder="https://github.com/owner/repo" aria-invalid={Boolean(errors.repoUrl)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Branch" error={errors.defaultBranch}>
          <Input value={form.defaultBranch} onChange={(e) => set({ defaultBranch: e.target.value })} aria-invalid={Boolean(errors.defaultBranch)} />
        </Field>
        <Field label="Business documents folder" hint="Markdown files here are what the BA agent reads first." error={errors.docsPath}>
          <Input value={form.docsPath} onChange={(e) => set({ docsPath: e.target.value })} aria-invalid={Boolean(errors.docsPath)} />
        </Field>
      </div>
      <Field label="Description (helps Triage pick the right system)" error={errors.description}>
        <Textarea value={form.description} maxLength={2000} rows={2} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field
        label={editing && existing?.hasToken ? "Replace read-only token (leave empty to keep the current one)" : "Read-only token (leave empty for a public repository)"}
        hint="A GitHub fine-grained token with read access to this repository only. It is stored as a company secret and is never shown again."
      >
        <Input
          type="password"
          value={token}
          autoComplete="new-password"
          onChange={(e) => { setToken(e.target.value); if (e.target.value) setRemoveToken(false); }}
          placeholder={editing && existing?.hasToken ? "Token is set" : ""}
        />
      </Field>
      {editing && existing?.hasToken ? (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={removeToken} disabled={token.length > 0} onChange={(e) => setRemoveToken(e.target.checked)} />
          Remove the stored token (the repository must then be public)
        </label>
      ) : null}
      {editing ? (
        <fieldset className="space-y-3 border-t border-border pt-3">
          <legend className="text-sm font-medium text-foreground">Dev agent</legend>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={devEnabled} onChange={(e) => setDevEnabled(e.target.checked)} />
            Let the Dev agent write code for this system (it only opens draft pull requests, never merges)
          </label>
          <Field
            label={existing?.hasWriteToken ? "Replace write token (leave empty to keep the current one)" : "Write token"}
            hint="A GitHub fine-grained token that can push branches and open pull requests on this repository only. The agent never sees it. Stored as a company secret and never shown again."
            error={devErrors.writeToken}
          >
            <Input
              type="password"
              value={writeToken}
              autoComplete="new-password"
              onChange={(e) => { setWriteToken(e.target.value); if (e.target.value) setRemoveWriteToken(false); }}
              placeholder={existing?.hasWriteToken ? "Token is set" : ""}
            />
          </Field>
          {existing?.hasWriteToken ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={removeWriteToken} disabled={writeToken.length > 0} onChange={(e) => setRemoveWriteToken(e.target.checked)} />
              Remove the stored write token (turn the Dev agent off first)
            </label>
          ) : null}
          <Field label="Test command (optional)" hint="Run by the agent before it finishes, e.g. cd backend && npm test." error={devErrors.testCommand}>
            <Input value={testCommand} maxLength={500} onChange={(e) => setTestCommand(e.target.value)} aria-invalid={Boolean(devErrors.testCommand)} />
          </Field>
          <Field label="Extra forbidden paths (optional)" hint="One per line. Changes to these are never pushed. Workflow and deploy files are always forbidden." error={devErrors.forbiddenPaths}>
            <Textarea value={forbiddenPaths} rows={3} onChange={(e) => setForbiddenPaths(e.target.value)} aria-invalid={Boolean(devErrors.forbiddenPaths)} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input className="mt-1" type="checkbox" checked={allowUnprotected} onChange={(e) => setAllowUnprotected(e.target.checked)} />
            <span>
              Allow when the default branch is not protected
              <span className="block text-xs text-muted-foreground">For repositories where GitHub cannot enforce branch protection. Only the company owner can turn this on. The agent still pushes only devflow/* branches and never merges.</span>
            </span>
          </label>
        </fieldset>
      ) : (
        <p className="text-xs text-muted-foreground">Save the system first, then edit it to set up the Dev agent.</p>
      )}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {editing ? "Save changes" : "Add system"}
        </Button>
      </div>
    </form>
  );
}

function SystemRow({ system, busy, onEdit, onToggle }: { system: DevflowSystem; busy: boolean; onEdit: () => void; onToggle: () => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-foreground">
          {system.name} <span className="font-mono text-xs text-muted-foreground">{system.key}</span>
        </p>
        <a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline" href={system.repoUrl} target="_blank" rel="noreferrer noopener">
          {system.repoUrl.replace("https://github.com/", "")} <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        <p className="text-xs text-muted-foreground">Branch {system.defaultBranch}, documents in {system.docsPath || "the repository root"}</p>
        {system.description ? <p className="text-xs text-muted-foreground">{system.description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{system.hasToken ? "Token set" : "Public repository"}</Badge>
        {system.devEnabled ? <Badge variant="outline">Dev agent on</Badge> : null}
        {system.active ? <Badge>Active</Badge> : <Badge variant="secondary">Switched off</Badge>}
        <Button type="button" size="sm" variant="outline" onClick={onEdit}>
          <Pencil className="h-4 w-4" /> Edit
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onToggle}>
          {system.active ? "Switch off" : "Switch on"}
        </Button>
      </div>
    </li>
  );
}

export function Systems() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [mode, setMode] = useState<{ kind: "none" } | { kind: "add" } | { kind: "edit"; id: string }>({ kind: "none" });

  useEffect(() => {
    setBreadcrumbs([{ label: "Systems" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const list = useQuery({
    queryKey: queryKeys.devflowSystems.list(selectedCompanyId ?? ""),
    queryFn: () => devflowSystemsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const toggle = useMutation({
    mutationFn: (s: DevflowSystem) => devflowSystemsApi.update(selectedCompanyId!, s.id, { active: !s.active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.devflowSystems.list(selectedCompanyId!) }),
    onError: (e) => pushToast({ title: "Could not change the system", body: systemsErrorMessage(e), tone: "error" }),
  });

  if (!selectedCompanyId) return <EmptyState icon={Server} message="Select an organization first." />;
  const items = list.data?.items ?? [];
  const editing = mode.kind === "edit" ? items.find((s) => s.id === mode.id) ?? null : null;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Systems</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The software systems requests can be about. Link each one to its GitHub repository: the BA agent reads the code and the business documents there to write the spec.
          </p>
        </div>
        {mode.kind === "none" ? (
          <Button type="button" onClick={() => setMode({ kind: "add" })}>
            <Plus className="h-4 w-4" /> Add system
          </Button>
        ) : null}
      </div>
      {mode.kind === "add" ? <SystemFormView key="add" companyId={selectedCompanyId} existing={null} onClose={() => setMode({ kind: "none" })} /> : null}
      {mode.kind === "edit" && editing ? <SystemFormView key={editing.id} companyId={selectedCompanyId} existing={editing} onClose={() => setMode({ kind: "none" })} /> : null}
      {list.isLoading ? (
        <PageSkeleton variant="list" />
      ) : list.isError ? (
        <p className="text-sm text-destructive" role="alert">Could not load systems: {systemsErrorMessage(list.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon={Server} message="No systems yet." description="Add the first system so Triage can assign it and the BA agent can read its repository." />
      ) : (
        <ul className="divide-y divide-border border border-border" aria-label="Systems">
          {items.map((s) => (
            <SystemRow key={s.id} system={s} busy={toggle.isPending} onEdit={() => setMode({ kind: "edit", id: s.id })} onToggle={() => toggle.mutate(s)} />
          ))}
        </ul>
      )}
    </div>
  );
}
