export const BASE = "/portal";

export type Route =
  | { name: "home" }
  | { name: "new" }
  | { name: "request"; number: number }
  | { name: "invite"; token: string }
  | { name: "notfound" };

/** Maps a location path (with or without the /portal base) to a route. */
export function parseRoute(pathname: string): Route {
  let path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  path = path.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/new") return { name: "new" };
  const request = /^\/requests\/(\d+)$/.exec(path);
  if (request) {
    const number = Number(request[1]);
    return Number.isSafeInteger(number) && number >= 1 ? { name: "request", number } : { name: "notfound" };
  }
  const invite = /^\/invite\/([A-Za-z0-9_-]{20,100})$/.exec(path);
  if (invite) return { name: "invite", token: invite[1] };
  return { name: "notfound" };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case "home":
      return `${BASE}/`;
    case "new":
      return `${BASE}/new`;
    case "request":
      return `${BASE}/requests/${route.number}`;
    case "invite":
      return `${BASE}/invite/${route.token}`;
    default:
      return `${BASE}/`;
  }
}
