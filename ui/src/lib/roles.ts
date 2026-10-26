// Pure helpers for DevFlow business roles (openspec change add-approver-roles): the "Roles" page and the
// "you cannot decide" notice on the three review pages. The server decides; these only explain.

export const ROLE_LABELS: Record<string, string> = { ba: "BA", tech_lead: "Tech Lead", qa: "QA" };
export const ROLE_HINTS: Record<string, string> = {
  ba: "Reviews triage proposals and BA specs.",
  tech_lead: "Reviews triage proposals, BA specs, technical plans, code and QA results.",
  qa: "Signs off QA results.",
};

export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

/** "BA or Tech Lead"; the labels are joined in the order the stage lists them. */
export function rolesSentence(roles: readonly string[]): string {
  const labels = roles.map(roleLabel);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** What the review screens get from the server alongside the proposal. */
export interface ReviewAccess {
  canDecide: boolean;
  requiredRoles: string[];
}

/** Why the decision buttons are off for this viewer, or null when they may decide. */
export function accessBlocker(access: Pick<ReviewAccess, "canDecide" | "requiredRoles">): string | null {
  if (access.canDecide) return null;
  if (access.requiredRoles.length > 0) {
    return `Only ${rolesSentence(access.requiredRoles)} (or the company owner) can decide here. Ask an owner to give you the role.`;
  }
  return "You are not the person assigned to decide this request.";
}

/** Add or remove one role, keeping the list in the order the server offers the roles. */
export function toggleRole(current: readonly string[], role: string, on: boolean, available: readonly string[]): string[] {
  const next = new Set(current);
  if (on) next.add(role);
  else next.delete(role);
  return available.filter((r) => next.has(r));
}

/** True when the draft differs from what is saved (order does not matter). */
export function rolesChanged(saved: readonly string[], draft: readonly string[]): boolean {
  return saved.length !== draft.length || saved.some((r) => !draft.includes(r));
}

export function rolesErrorMessage(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const body = (error as { body?: { error?: string } } | null)?.body;
  if (status === 403) return "Only the company owner can change roles.";
  if (status === 404) return "Not found or no longer available.";
  if (status === 422) return body?.error || "That change is not allowed.";
  return body?.error || (error instanceof Error ? error.message : "Something went wrong. Try again.");
}
