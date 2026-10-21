import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { devflowRolesApi, type MemberRoleItem } from "../api/devflowRoles";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ROLE_HINTS, roleLabel, rolesErrorMessage, toggleRole } from "../lib/roles";

// DevFlow "Roles": who is a BA or a Tech Lead. The review stages (Triage, BA spec, Technical plan) only let a
// person with the right role, or the company owner, decide. A person can hold several roles. Only the owner can
// change them; everyone else sees the list read-only. Each tick saves at once and is written to the audit log.

export function Roles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  useEffect(() => {
    setBreadcrumbs([{ label: "Roles" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const list = useQuery({
    queryKey: queryKeys.devflowRoles.list(selectedCompanyId ?? ""),
    queryFn: () => devflowRolesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const save = useMutation({
    mutationFn: (v: { userId: string; roles: string[] }) => devflowRolesApi.set(selectedCompanyId!, v.userId, v.roles),
    onSuccess: () => pushToast({ title: "Roles saved", tone: "success" }),
    onError: (e) => pushToast({ title: "Roles not saved", body: rolesErrorMessage(e), tone: "error" }),
    // refetch on success and on failure: the screen always shows what the server holds
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.devflowRoles.list(selectedCompanyId!) }),
  });

  if (!selectedCompanyId) return <EmptyState icon={ShieldCheck} message="Select an organization first." />;
  const data = list.data;
  const available = data?.availableRoles ?? [];
  const pendingUser = save.isPending ? save.variables?.userId : null;

  const change = (item: MemberRoleItem, role: string, on: boolean) =>
    save.mutate({ userId: item.userId, roles: toggleRole(item.roles, role, on, available) });

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Roles</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose who can approve at the review stages. A person can hold more than one role. The company owner can always decide, so owners need no role.
        </p>
      </div>

      {list.isLoading ? (
        <PageSkeleton variant="list" />
      ) : list.isError || !data ? (
        <p className="text-sm text-destructive" role="alert">Could not load roles: {rolesErrorMessage(list.error)}</p>
      ) : (
        <>
          {!data.canManage ? <p className="text-sm text-muted-foreground">Only the company owner can change roles. You can see who holds them.</p> : null}
          <ul className="space-y-1 text-xs text-muted-foreground" aria-label="What each role can decide">
            {available.map((r) => (
              <li key={r}>
                <span className="font-medium text-foreground">{roleLabel(r)}:</span> {ROLE_HINTS[r] ?? ""}
              </li>
            ))}
          </ul>
          {data.items.length === 0 ? (
            <EmptyState icon={ShieldCheck} message="No staff in this organization yet." />
          ) : (
            <table className="w-full border border-border text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="p-2 font-medium">Person</th>
                  {available.map((r) => (
                    <th key={r} className="p-2 text-center font-medium">{roleLabel(r)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const busy = pendingUser === item.userId;
                  return (
                    <tr key={item.userId} className="border-b border-border last:border-0">
                      <td className="p-2">
                        <p className="font-medium text-foreground">
                          {item.name || item.email}
                          {item.alwaysApproves ? <Badge variant="secondary" className="ml-2">Owner: can always decide</Badge> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">{item.email}</p>
                      </td>
                      {available.map((r) => (
                        <td key={r} className="p-2 text-center">
                          {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" aria-hidden /> : null}
                          {busy ? null : (
                            <Checkbox
                              aria-label={`${roleLabel(r)} for ${item.name || item.email}`}
                              checked={item.roles.includes(r)}
                              disabled={!data.canManage || save.isPending}
                              onCheckedChange={(v) => change(item, r, v === true)}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
