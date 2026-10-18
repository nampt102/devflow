import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, describeError, type SessionUser } from "./api";
import { EyeIcon, EyeOffIcon, LogoMark, MoonIcon, SunIcon } from "./icons";
import { DetailPage, HomePage, NewRequestPage, NotFoundPage } from "./pages";
import { parseRoute, pathFor, type Route } from "./route";
import { applyTheme, initialTheme, otherTheme, parseTheme, saveTheme, THEME_KEY, type Theme } from "./theme";
import { Alert, Spinner, type Navigate } from "./ui";
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

/** Light/dark, shared with the Paperclip board through the same storage key (see theme.ts). */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    // the board (or another tab) changed the choice
    const onStorage = (event: StorageEvent) => {
      const next = event.key === THEME_KEY ? parseTheme(event.newValue) : null;
      if (next) setTheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = useCallback(() => {
    const next = otherTheme(theme);
    saveTheme(next);
    setTheme(next);
  }, [theme]);
  return [theme, toggle];
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === "dark" ? vi.theme.toLight : vi.theme.toDark;
  return (
    <button type="button" className="btn btn-ghost btn-icon" onClick={onToggle} aria-label={label} title={label}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="auth-wrap">{children}</div>;
}

function Loading() {
  return (
    <Centered>
      <p className="muted" role="status">
        <Spinner /> {vi.loading}
      </p>
    </Centered>
  );
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
  const [showPassword, setShowPassword] = useState(false);
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
    <Centered>
      <div className="auth card form-card">
        <LogoMark />
        <h1>{inviteMode ? vi.auth.inviteTitle : vi.auth.title}</h1>
        {inviteMode ? <p className="muted">{vi.auth.inviteHint}</p> : <p className="muted">{vi.auth.noAccountHint}</p>}
        <form className="form" onSubmit={submit}>
          {error && <Alert kind="error">{error}</Alert>}
          {register && (
            <div className="field">
              <label className="label" htmlFor="auth-name">{vi.auth.name}</label>
              <input id="auth-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor="auth-email">{vi.auth.email}</label>
            <input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          <div className="field">
            <label className="label" htmlFor="auth-password">{vi.auth.password}</label>
            <div className="input-row">
              <input
                id="auth-password"
                type={showPassword ? "text" : "password"}
                value={password}
                minLength={register ? 8 : undefined}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={register ? "new-password" : "current-password"}
                aria-describedby={register ? "auth-password-hint" : undefined}
                required
              />
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? vi.auth.hidePassword : vi.auth.showPassword} aria-pressed={showPassword}>
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {register && <span id="auth-password-hint" className="hint">{vi.auth.passwordHint}</span>}
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {busy ? vi.auth.signingIn : register ? vi.auth.registerAndAccept : vi.auth.signIn}
          </button>
          {inviteMode && (
            <button type="button" className="link-button" onClick={() => { setRegister(!register); setError(null); }}>
              {register ? vi.auth.switchToSignIn : vi.auth.switchToRegister}
            </button>
          )}
        </form>
      </div>
    </Centered>
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

  if (state.phase === "working") {
    return (
      <Centered>
        <p className="muted" role="status">
          <Spinner /> {vi.invite.accepting}
        </p>
      </Centered>
    );
  }
  if (state.phase === "error") {
    return (
      <Centered>
        <div className="auth card form-card">
          <Alert kind="error">{state.message}</Alert>
          <button className="btn btn-secondary" onClick={() => navigate({ name: "home" })}>{vi.back}</button>
        </div>
      </Centered>
    );
  }
  return (
    <Centered>
      <div className="auth card form-card">
        <Alert kind="success">{vi.invite.done}</Alert>
        <button className="btn btn-primary" onClick={() => navigate({ name: "home" })}>{vi.invite.start}</button>
      </div>
    </Centered>
  );
}

export function App() {
  const [route, navigate, notice] = useRoute();
  const [theme, toggleTheme] = useTheme();
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

  let body: ReactNode;
  if (auth.state === "loading") {
    body = <Loading />;
  } else if (auth.state === "out") {
    body = <AuthPanel inviteToken={route.name === "invite" ? route.token : undefined} onAuthed={() => void refresh()} />;
  } else if (route.name === "invite") {
    body = <InviteGate token={route.token} onAccepted={() => void refresh()} navigate={navigate} />;
  } else if (access === "checking") {
    body = <Loading />;
  } else if (access === "none") {
    body = (
      <Centered>
        <div className="auth card form-card">
          <h1>{vi.noAccess.title}</h1>
          <p className="muted">{vi.noAccess.body}</p>
        </div>
      </Centered>
    );
  } else if (access === "error") {
    body = (
      <Centered>
        <div className="auth card form-card">
          <Alert kind="error">{vi.errors.generic}</Alert>
          <button className="btn btn-primary" onClick={() => void refresh()}>{vi.retry}</button>
        </div>
      </Centered>
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
      <a className="skip-link" href="#main">{vi.skipToContent}</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={pathFor({ name: "home" })} onClick={(e) => { e.preventDefault(); navigate({ name: "home" }); }}>
            <LogoMark />
            <span>DevFlow</span>
            <span className="brand-sub">{vi.brandSub}</span>
          </a>
          <div className="top-actions">
            {auth.state === "in" && <span className="who-email">{auth.user.email}</span>}
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            {auth.state === "in" && (
              <button className="btn btn-ghost" onClick={() => void signOut()}>{vi.signOut}</button>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="container">{body}</main>
    </>
  );
}
