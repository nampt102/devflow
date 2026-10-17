import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, describeError, type SessionUser } from "./api";
import { DetailPage, HomePage, NewRequestPage, NotFoundPage, type Navigate } from "./pages";
import { parseRoute, pathFor, type Route } from "./route";
import { vi } from "./vi";

type Access = "checking" | "ok" | "none" | "error";
type Auth = { state: "loading" } | { state: "out" } | { state: "in"; user: SessionUser };

function useRoute(): [Route, Navigate, string | undefined] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [notice, setNotice] = useState<string | undefined>();
  useEffect(() => {
    const onPop = () => {
      setRoute(parseRoute(window.location.pathname));
      setNotice(undefined);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback<Navigate>((next, state) => {
    window.history.pushState(null, "", pathFor(next));
    setRoute(next);
    setNotice(state?.notice);
    window.scrollTo(0, 0);
  }, []);
  return [route, navigate, notice];
}

/**
 * Without an invitation only sign-in is offered: accounts are created through an invitation link
 * (POST /api/portal/invites/:token/register), which keeps working when public sign-up is closed.
 */
function AuthPanel({ inviteToken, onAuthed }: { inviteToken?: string; onAuthed: () => void }) {
  const inviteMode = Boolean(inviteToken);
  const [register, setRegister] = useState(inviteMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (register && inviteToken) {
        // one step creates the account and consumes the link; then a normal sign-in starts the session
        await api.registerWithInvite(inviteToken, name.trim(), email.trim(), password);
      }
      await api.signIn(email.trim(), password);
      onAuthed();
    } catch (err) {
      if (err instanceof ApiError && err.code === "account_exists") setRegister(false); // the link is still valid
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1>{inviteMode ? vi.auth.inviteTitle : vi.auth.title}</h1>
      {inviteMode ? <p className="muted">{vi.auth.inviteHint}</p> : <p className="muted">{vi.auth.noAccountHint}</p>}
      <form className="form" onSubmit={submit}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {register && (
          <label className="field">
            <span className="label">{vi.auth.name}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="field">
          <span className="label">{vi.auth.email}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label className="field">
          <span className="label">{vi.auth.password}</span>
          <input
            type="password"
            value={password}
            minLength={register ? 8 : undefined}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={register ? "new-password" : "current-password"}
            required
          />
          {register && <span className="hint">{vi.auth.passwordHint}</span>}
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {register ? vi.auth.registerAndAccept : vi.auth.signIn}
        </button>
        {inviteMode && (
          <button type="button" className="link-button" onClick={() => { setRegister(!register); setError(null); }}>
            {register ? vi.auth.switchToSignIn : vi.auth.switchToRegister}
          </button>
        )}
      </form>
    </div>
  );
}

/** Signed-in user opened an invitation link: accept it once, then continue to the portal. */
function InviteGate({ token, onAccepted, navigate }: { token: string; onAccepted: () => void; navigate: Navigate }) {
  const [state, setState] = useState<{ phase: "working" | "done" | "error"; message?: string }>({ phase: "working" });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; a link must be used once
    started.current = true;
    api.acceptInvite(token).then(
      () => { onAccepted(); setState({ phase: "done" }); },
      (err) => {
        // already a requester here: nothing consumed, simply continue
        if (err instanceof ApiError && err.status === 409) { onAccepted(); setState({ phase: "done" }); return; }
        setState({ phase: "error", message: describeError(err) });
      },
    );
  }, [token, onAccepted]);

  if (state.phase === "working") return <p className="muted">{vi.invite.accepting}</p>;
  if (state.phase === "error") {
    return (
      <div className="auth">
        <div className="alert alert-error" role="alert">{state.message}</div>
        <button className="btn btn-ghost" onClick={() => navigate({ name: "home" })}>{vi.back}</button>
      </div>
    );
  }
  return (
    <div className="auth">
      <div className="alert alert-success" role="status">{vi.invite.done}</div>
      <button className="btn btn-primary" onClick={() => navigate({ name: "home" })}>{vi.invite.start}</button>
    </div>
  );
}

export function App() {
  const [route, navigate, notice] = useRoute();
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const [access, setAccess] = useState<Access>("checking");

  const refresh = useCallback(async () => {
    try {
      const user = await api.session();
      if (!user) {
        setAuth({ state: "out" });
        return;
      }
      setAuth({ state: "in", user });
      setAccess("checking");
      try {
        await api.me();
        setAccess("ok");
      } catch (err) {
        setAccess(err instanceof ApiError && err.status === 403 ? "none" : "error");
      }
    } catch {
      setAuth({ state: "out" });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { document.title = vi.appName; }, []);

  async function signOut() {
    try { await api.signOut(); } catch { /* the session is gone either way */ }
    setAuth({ state: "out" });
    navigate({ name: "home" });
  }

  let body: React.ReactNode;
  if (auth.state === "loading") {
    body = <p className="muted">{vi.loading}</p>;
  } else if (auth.state === "out") {
    body = <AuthPanel inviteToken={route.name === "invite" ? route.token : undefined} onAuthed={() => void refresh()} />;
  } else if (route.name === "invite") {
    body = <InviteGate token={route.token} onAccepted={() => void refresh()} navigate={navigate} />;
  } else if (access === "checking") {
    body = <p className="muted">{vi.loading}</p>;
  } else if (access === "none") {
    body = (
      <div className="auth">
        <h1>{vi.noAccess.title}</h1>
        <p>{vi.noAccess.body}</p>
      </div>
    );
  } else if (access === "error") {
    body = (
      <div className="auth">
        <div className="alert alert-error" role="alert">{vi.errors.generic}</div>
        <button className="btn btn-primary" onClick={() => void refresh()}>{vi.retry}</button>
      </div>
    );
  } else if (route.name === "new") {
    body = <NewRequestPage navigate={navigate} />;
  } else if (route.name === "request") {
    body = <DetailPage number={route.number} navigate={navigate} notice={notice} />;
  } else if (route.name === "home") {
    body = <HomePage navigate={navigate} />;
  } else {
    body = <NotFoundPage navigate={navigate} />;
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={pathFor({ name: "home" })} onClick={(e) => { e.preventDefault(); navigate({ name: "home" }); }}>
            {vi.appName}
          </a>
          {auth.state === "in" && (
            <div className="who">
              <span className="muted who-email">{auth.user.email}</span>
              <button className="link-button" onClick={() => void signOut()}>{vi.signOut}</button>
            </div>
          )}
        </div>
      </header>
      <main className="container">{body}</main>
    </>
  );
}
