"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { AuthFrame, LoginCard, Banner } from "./login-card";
import { ProfileNameCard } from "./profile-name-card";
import {
  bumpIdentityGeneration,
  clearPrivateBrowserState,
  enterIdentity,
  onUnauthenticated,
} from "@/lib/identity";
import {
  fetchMe,
  meKey,
  openTabChannel,
  signOut as endSession,
  switchWorkspace,
  type Me,
  type MeResult,
} from "@/lib/session";
import { loginNotice } from "@/lib/login";

export interface SessionActions {
  /** Ends the session and clears everything private from this tab. */
  signOut: () => void;
  /** Moves to another workspace; resolves with a message if it could not. */
  switchTo: (tenantId: string) => Promise<string | null>;
  /** Asks the platform whether this tab still belongs to the same person. */
  recheck: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; me: Me }
  | { kind: "signedOut"; notice?: string; retrySignOut?: boolean }
  | { kind: "blocked"; message: string }
  | { kind: "unavailable"; message: string };

// A tab that comes back into view, or is restored from the back/forward cache,
// asks again at most this often.
const RECHECK_MS = 5_000;

/**
 * Nothing private is shown, and no private request is made, until the platform
 * has said who this is. "Signed out" and "the platform is down" are different
 * screens: only an actual 401 is a sign-out, so an outage never looks like one
 * and never discards anything the person has typed.
 */
export function SessionGate({
  children,
}: {
  children: (me: Me, actions: SessionActions) => ReactNode;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  const current = useRef<Me | null>(null);
  const checking = useRef(false);
  const lastCheck = useRef(0);
  const channel = useRef<ReturnType<typeof openTabChannel> | null>(null);

  // Stops showing the previous person's view before anything else happens.
  const leave = useCallback((next: SetStateAction<State>) => {
    bumpIdentityGeneration();
    clearPrivateBrowserState();
    current.current = null;
    // Nothing of the old view is left in the address bar either.
    if (location.search) history.replaceState(null, "", location.pathname);
    setState(next);
  }, []);

  const apply = useCallback(
    (result: MeResult) => {
      if (result.kind === "ok") {
        const before = current.current;
        if (before && meKey(before) !== meKey(result.me)) {
          // A different person or workspace than this tab was showing: start over.
          bumpIdentityGeneration();
          location.reload();
          return;
        }
        if (!before) {
          enterIdentity(result.me.user.id, result.me.tenant.id);
          channel.current?.post({ type: "login", key: meKey(result.me) });
        }
        current.current = result.me;
        // New role or workspace list: shown without discarding the view.
        setState({ kind: "ready", me: result.me });
      } else if (result.kind === "onboarding") {
        bumpIdentityGeneration();
        clearPrivateBrowserState();
        location.replace("/onboarding");
      } else if (result.kind === "signedOut") {
        leave((previous) => {
          // No session in a fresh browser is normal. Only an established
          // session ending needs a notice; retain explicit sign-out feedback.
          if (previous.kind === "signedOut") return previous;
          return {
            kind: "signedOut",
            notice:
              previous.kind === "ready" || previous.kind === "blocked"
                ? "session_ended"
                : undefined,
          };
        });
      } else if (result.kind === "blocked") {
        // Signed in but unusable: keep the identity so Sign out is offered.
        bumpIdentityGeneration();
        setState({ kind: "blocked", message: result.message });
      } else if (!current.current)
        setState({ kind: "unavailable", message: result.message });
      // An outage while a view is open leaves that view as it is.
    },
    [leave],
  );

  const check = useCallback(
    async (force = false) => {
      if (checking.current) return;
      if (!force && Date.now() - lastCheck.current < RECHECK_MS) return;
      checking.current = true;
      lastCheck.current = Date.now();
      try {
        apply(await fetchMe());
      } finally {
        checking.current = false;
      }
    },
    [apply],
  );

  useEffect(() => {
    channel.current = openTabChannel((m) => {
      // Another tab signed out, switched workspace or signed in as someone: the
      // server's cookie is shared, so this tab starts over from it.
      if (
        m.type === "login" &&
        current.current &&
        m.key === meKey(current.current)
      )
        return;
      bumpIdentityGeneration();
      location.reload();
    });
    void check(true);
    const stop = onUnauthenticated(() => void check(true));
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const shown = (e: PageTransitionEvent) => {
      // Restored from the back/forward cache: it may be someone else's view now.
      if (e.persisted) void check(true);
    };
    document.addEventListener("visibilitychange", visible);
    addEventListener("pageshow", shown);
    addEventListener("online", visible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visible);
      removeEventListener("pageshow", shown);
      removeEventListener("online", visible);
      channel.current?.close();
      channel.current = null;
    };
  }, [check]);

  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    const { confirmed } = await endSession();
    channel.current?.post({ type: "logout" });
    setSigningOut(false);
    // The view is cleared whatever the server said; only the wording differs.
    leave({
      kind: "signedOut",
      notice: confirmed ? "signed_out" : "logout_failed",
      retrySignOut: !confirmed,
    });
  }, [leave, signingOut]);

  const switchTo = useCallback(
    async (tenantId: string) => {
      const result = await switchWorkspace(tenantId);
      if (!result.ok) {
        if (result.signedOut)
          leave({ kind: "signedOut", notice: "session_ended" });
        return result.message;
      }
      bumpIdentityGeneration();
      channel.current?.post({ type: "switch" });
      // A full load: every stream is closed and every old-workspace response is
      // gone before the new workspace is fetched.
      location.assign("/");
      return null;
    },
    [leave],
  );

  const recheck = useCallback(() => void check(true), [check]);
  const actions: SessionActions = {
    signOut: () => void signOut(),
    switchTo,
    recheck,
  };

  if (state.kind === "ready") {
    if (state.me.auth === "google" && state.me.user.nameRequired)
      return (
        <ProfileNameCard
          key={state.me.user.id}
          user={state.me.user}
          onSaved={() => location.reload()}
          onSessionChanged={recheck}
          onSignOut={actions.signOut}
          signingOut={signingOut}
        />
      );
    return <>{children(state.me, actions)}</>;
  }
  if (state.kind === "signedOut")
    return (
      <LoginCard
        notice={loginNotice(state.notice)}
        action={
          state.retrySignOut
            ? {
                label: "Try signing out again",
                onClick: () => void signOut(),
                busy: signingOut,
              }
            : undefined
        }
      />
    );
  if (state.kind === "blocked")
    return (
      <AuthFrame>
        <section className="au-card" aria-labelledby="au-title">
          <h1 id="au-title">Can’t open this workspace</h1>
          <Banner notice={{ tone: "warn", lead: state.message }} />
          <div className="au-actions">
            <button
              type="button"
              className="au-btn primary"
              onClick={() => void signOut()}
              disabled={signingOut}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            <button
              type="button"
              className="au-btn"
              onClick={() => void check(true)}
            >
              Check again
            </button>
          </div>
        </section>
      </AuthFrame>
    );
  if (state.kind === "unavailable")
    return (
      <AuthFrame>
        <section className="au-card" aria-labelledby="au-title">
          <h1 id="au-title">Truex is unavailable</h1>
          <Banner notice={{ tone: "warn", lead: state.message }} />
          <div className="au-actions">
            <button
              type="button"
              className="au-btn primary"
              onClick={() => {
                setState({ kind: "loading" });
                void check(true);
              }}
            >
              Try again
            </button>
          </div>
        </section>
      </AuthFrame>
    );
  return (
    <AuthFrame>
      <div className="au-status" role="status" aria-live="polite">
        <span className="au-dot" aria-hidden="true" />
        Checking your session…
      </div>
    </AuthFrame>
  );
}
