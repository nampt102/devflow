import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Link } from "@/lib/router";
import { api, ApiError } from "../api/client";
import { devflowSetupApi, type SetupRole, type SetupStatus } from "../api/devflowSetup";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { ANTHROPIC_SECRET_NAME, ROLE_TITLES, SetupError, agentBadge, ensureAgent, setupBlocker, syncPipeline, type SetupHttp } from "../lib/agent-setup";
import { queryKeys } from "../lib/queryKeys";

// DevFlow "Setup": what the setup scripts do, for a company owner or admin. Each row says what is missing and has one button; the
// buttons run the same steps as scripts/devflow/setup-*.mjs through the ordinary Paperclip APIs with the signed-in person's rights.
// The runner (containers) is only shown: building it is an operator's job, not a button.

const http: SetupHttp = {
  get: (path) => api.get(path),
  post: (path, body) => api.post(path, body),
  put: (path, body) => api.put(path, body),
  patch: (path, body) => api.patch(path, body),
};
const ROLES: SetupRole[] = ["ba", "plan", "dev", "qa"];

function toneBadge(tone: "ok" | "warn" | "off") {
  return tone === "ok" ? "secondary" : tone === "warn" ? "destructive" : "outline";
}

export function Setup() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  // The key lives only in this page's memory and is cleared after it is saved.
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Setup" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const statusQuery = useQuery({
    queryKey: queryKeys.devflowSetup.status(selectedCompanyId ?? "none"),
    queryFn: () => devflowSetupApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
    retry: false,
  });
  const secretsQuery = useQuery({
    queryKey: queryKeys.devflowSetup.secrets(selectedCompanyId ?? "none"),
    queryFn: () => api.get<Array<{ name: string; status?: string }> | { items: Array<{ name: string; status?: string }> }>(`/companies/${selectedCompanyId}/secrets`),
    enabled: !!selectedCompanyId,
    retry: false,
  });
  const secretRows = Array.isArray(secretsQuery.data) ? secretsQuery.data : (secretsQuery.data?.items ?? []);
  const hasKeyOnFile = secretRows.some((s) => s.name === ANTHROPIC_SECRET_NAME && s.status !== "deleted");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["devflow-setup", selectedCompanyId] });

  const run = useMutation({
    mutationFn: async (what: SetupRole | "pipeline") => {
      setBusy(what);
      const status = statusQuery.data!;
      if (what === "pipeline") return { what, message: await syncPipeline(http, selectedCompanyId!, status.pipeline) };
      const result = await ensureAgent(http, { companyId: selectedCompanyId!, role: what, anthropicKey: key || undefined });
      return { what, message: result.state === "ready" ? `${ROLE_TITLES[what].label} agent ready` : result.state === "verifying" ? `${ROLE_TITLES[what].label} agent is being verified; press Update again in a minute` : `${ROLE_TITLES[what].label} agent still has a problem: ${result.problem}` };
    },
    onSuccess: async ({ message }) => {
      setKey("");
      pushToast({ title: message, tone: "success" });
      await refresh();
    },
    onError: (error) => {
      pushToast({ title: "Setup step failed", body: error instanceof SetupError || error instanceof ApiError || error instanceof Error ? error.message : "Try again.", tone: "error" });
      refresh();
    },
    onSettled: () => setBusy(null),
  });

  if (!selectedCompanyId) return <EmptyState icon={Settings2} message="Select an organization to set up." />;
  if (statusQuery.isLoading) return <PageSkeleton variant="list" />;
  if (statusQuery.error || !statusQuery.data) {
    const forbidden = statusQuery.error instanceof ApiError && statusQuery.error.status === 403;
    return <EmptyState icon={AlertTriangle} message={forbidden ? "Only a company owner or admin can use Setup." : "The setup state could not be loaded. Try again in a moment."} />;
  }
  const s: SetupStatus = statusQuery.data;
  const pipelineLine = !s.pipeline.exists
    ? { label: "Not created", tone: "off" as const, action: "Create" }
    : s.pipeline.patches.length || s.pipeline.transitions
      ? { label: "Needs sync", tone: "warn" as const, action: "Sync", detail: [s.pipeline.patches.length ? `${s.pipeline.patches.length} stage setting${s.pipeline.patches.length === 1 ? "" : "s"} differ` : "", s.pipeline.transitionsMissing ? `${s.pipeline.transitionsMissing} transition${s.pipeline.transitionsMissing === 1 ? "" : "s"} missing` : ""].filter(Boolean).join(", ") }
      : { label: "Up to date", tone: "ok" as const, action: null };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Setup</h1>
        <p className="mt-1 text-sm text-muted-foreground">What each DevFlow stage needs for this company. The buttons run the same steps as the setup scripts, with your own permissions. Safe to press again.</p>
      </div>

      <section className="space-y-2 border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">Agents</h2>
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">Anthropic key {hasKeyOnFile ? "(a key is on file; paste one only to replace it)" : "(needed once, stored as a company secret and never shown again)"}</span>
          <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKeyOnFile ? "leave empty to keep the key on file" : "sk-ant-..."} />
        </label>
        <ul className="divide-y divide-border">
          {ROLES.map((role) => {
            const agent = s.agents[role];
            const badge = agentBadge(agent);
            const blocker = setupBlocker(agent, hasKeyOnFile, key);
            return (
              <li key={role} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {ROLE_TITLES[role].label} <Badge variant={toneBadge(badge.tone)}>{badge.label}</Badge>
                  </p>
                  {badge.detail ? <p className="text-xs text-muted-foreground">{badge.detail}</p> : null}
                </div>
                {badge.action ? (
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null || !!blocker} title={blocker ?? undefined} onClick={() => run.mutate(role)}>
                    {busy === role ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {badge.action === "create" ? "Create" : "Update"}
                  </Button>
                ) : (
                  <Check className="h-4 w-4 text-muted-foreground" aria-label="Ready" />
                )}
              </li>
            );
          })}
        </ul>
        {s.agents.dev || s.agents.qa || !s.runner.environment ? null : <p className="text-xs text-muted-foreground">Dev and QA need the runner below.</p>}
      </section>

      <section className="space-y-2 border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">Pipeline "dev-request"</h2>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Badge variant={toneBadge(pipelineLine.tone)}>{pipelineLine.label}</Badge>
            {"detail" in pipelineLine && pipelineLine.detail ? <span className="ml-2 text-xs text-muted-foreground">{pipelineLine.detail}</span> : null}
          </div>
          {pipelineLine.action ? (
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => run.mutate("pipeline")}>
              {busy === "pipeline" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {pipelineLine.action}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">Sync only adds what is missing (approver roles, the QA sign-off's way back to Dev, transitions); it removes nothing.</p>
        {s.pipeline.patches.length ? <p className="text-xs text-amber-700 dark:text-amber-300">Sync switches the review stages from "any staff" to the BA / Tech Lead / QA roles: give people their roles on Roles first, or only owners will be able to decide.</p> : null}
      </section>

      <section className="space-y-2 border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">Runner</h2>
        <p className="text-sm text-foreground">
          <Badge variant={s.runner.environment && s.runner.reachable ? "secondary" : "destructive"}>{!s.runner.environment ? "Not set up" : s.runner.reachable ? "Reachable" : "Unreachable"}</Badge>
        </p>
        {!s.runner.environment || !s.runner.reachable ? (
          <p className="text-xs text-muted-foreground">
            {!s.runner.environment ? "The runner environment does not exist." : "The server cannot reach the runner (after recreating the server container the network link is lost)."} An operator runs this once from the repository:
            <code className="mt-1 block bg-muted/40 p-2 font-mono text-xs">node scripts/devflow/setup-dev-runner.mjs --company {selectedCompanyId}</code>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Dev and QA run here. Containers are managed by an operator, not from this page.</p>
        )}
      </section>

      <p className="text-sm text-muted-foreground">
        Also needed: a write token and the Dev switch for each repository on <Link to="/systems" className="underline underline-offset-2">Systems</Link>, and the staff roles on <Link to="/roles" className="underline underline-offset-2">Roles</Link>.
      </p>
    </div>
  );
}
