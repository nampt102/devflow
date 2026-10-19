// Which company the person is working in, when they are a requester of several. One company needs no choice;
// with more, the last choice is remembered in this browser. Nothing here is secret: only a company id.

export type CompanyChoice = { companyId: string; name: string };

export const COMPANY_KEY = "devflow.portal.company";

export type Picked = { kind: "none" } | { kind: "use"; companyId: string } | { kind: "ask" };

/** What to do with the list the server returned and the company chosen last time (may be stale or absent). */
export function chooseCompany(items: readonly CompanyChoice[], saved: string | null): Picked {
  if (items.length === 0) return { kind: "none" };
  if (items.length === 1) return { kind: "use", companyId: items[0]!.companyId };
  if (saved && items.some((i) => i.companyId === saved)) return { kind: "use", companyId: saved };
  return { kind: "ask" };
}

export function readSavedCompany(): string | null {
  try {
    return localStorage.getItem(COMPANY_KEY);
  } catch {
    return null;
  }
}

export function saveCompany(companyId: string): void {
  try {
    localStorage.setItem(COMPANY_KEY, companyId);
  } catch {
    /* storage can be blocked: the choice is simply asked again next time */
  }
}

/** The portal calls that act inside one company: they carry `companyId`. Invitations and the company list do not. */
export function withCompany(path: string, companyId: string | null): string {
  if (!companyId) return path;
  if (path !== "/api/portal/me" && !path.startsWith("/api/portal/requests")) return path;
  return `${path}${path.includes("?") ? "&" : "?"}companyId=${encodeURIComponent(companyId)}`;
}
