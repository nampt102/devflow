import type { ReactNode } from "react";
import { AlertIcon, CheckIcon } from "./icons";
import { pathFor, type Route } from "./route";
import { STATUS_CLOSED, STATUS_DONE } from "./vi";

export type Navigate = (route: Route, state?: { notice?: string }) => void;

export function Link({ to, navigate, className, children }: { to: Route; navigate: Navigate; className?: string; children: ReactNode }) {
  return (
    <a
      className={className}
      href={pathFor(to)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

export function Alert({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "error" ? <AlertIcon /> : <CheckIcon />}
      <div>{children}</div>
    </div>
  );
}

/** Colour follows the server's terminal labels; the text is always shown, so colour is never the only signal. */
export function StatusChip({ label }: { label: string }) {
  const tone = label === STATUS_DONE ? "done" : label === STATUS_CLOSED ? "closed" : "active";
  return <span className={`chip chip-${tone}`}>{label}</span>;
}

export function ListSkeleton() {
  return (
    <div className="skeleton-list" aria-hidden="true">
      <div className="skeleton skeleton-card" />
      <div className="skeleton skeleton-card" />
      <div className="skeleton skeleton-card" />
    </div>
  );
}
