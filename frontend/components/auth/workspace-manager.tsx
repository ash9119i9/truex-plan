"use client";
import { useEffect, useRef, useState } from "react";
import { AuthFrame, Banner, LoginCard } from "./login-card";
import {
  clearPrivateBrowserState,
  bumpIdentityGeneration,
} from "@/lib/identity";
import { openTabChannel, signOut, switchWorkspace } from "@/lib/session";
import {
  fetchAccount,
  type Account,
  type WorkspaceResult,
} from "@/lib/workspaces";
import { WorkspaceInvitations } from "./workspace-invitations";
import { Icon } from "@/components/v2/icon";
import { useTheme } from "@/lib/use-theme";
import { GoogleButton } from "./google-button";
import { GOOGLE_START } from "@/lib/login";

export function WorkspaceManager({
  onboarding = false,
}: {
  onboarding?: boolean;
}) {
  const { isDark, toggle } = useTheme();
  const [account, setAccount] = useState<Account | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const knownAccount = useRef<Account | null>(null);
  const channel = useRef<ReturnType<typeof openTabChannel> | null>(null);

  function signedOutView() {
    bumpIdentityGeneration();
    clearPrivateBrowserState();
    setSignedOut(true);
  }

  function failure(result: Extract<WorkspaceResult<unknown>, { ok: false }>) {
    if (result.signedOut) signedOutView();
    else setError(result.message);
  }
  async function enter(id: string) {
    const result = await switchWorkspace(id);
    if (!mounted.current) return false;
    if (!result.ok) {
      if (result.signedOut) signedOutView();
      else setError(result.message);
      return false;
    }
    bumpIdentityGeneration();
    clearPrivateBrowserState();
    channel.current?.post({ type: "switch" });
    location.assign("/");
    return true;
  }
  useEffect(() => {
    mounted.current = true;
    let live = true;
    channel.current = openTabChannel(() => {
      bumpIdentityGeneration();
      clearPrivateBrowserState();
      location.reload();
    });
    void fetchAccount().then((result) => {
      if (!live) return;
      setReady(true);
      if (!result.ok) return failure(result);
      knownAccount.current = result.value;
      setAccount(result.value);
      if (
        result.value.showWorkspaces === false ||
        (onboarding &&
          result.value.tenantId &&
          result.value.tenants.some((t) => t.id === result.value.tenantId))
      )
        location.replace("/");
    });
    const recheck = () => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      void fetchAccount().then((result) => {
        if (!live) return;
        if (!result.ok) {
          if (result.signedOut) signedOutView();
          return;
        }
        const before = knownAccount.current;
        if (
          before &&
          (before.user.id !== result.value.user.id ||
            before.tenantId !== result.value.tenantId)
        ) {
          bumpIdentityGeneration();
          clearPrivateBrowserState();
          location.reload();
        } else {
          knownAccount.current = result.value;
          setAccount(result.value);
          if (result.value.showWorkspaces === false) location.replace("/");
        }
      });
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) recheck();
    };
    document.addEventListener("visibilitychange", recheck);
    addEventListener("pageshow", restored);
    return () => {
      live = false;
      mounted.current = false;
      document.removeEventListener("visibilitychange", recheck);
      removeEventListener("pageshow", restored);
      channel.current?.close();
      channel.current = null;
    };
  }, [onboarding]);

  async function choose(id: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(id);
    setError("");
    try {
      await enter(id);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function leave() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("logout");
    const result = await signOut();
    inFlight.current = false;
    setBusy("");
    if (!result.confirmed)
      return setError("We couldn't confirm sign-out. Try again.");
    clearPrivateBrowserState();
    channel.current?.post({ type: "logout" });
    location.replace("/login");
  }
  if (signedOut) return <LoginCard />;
  const admins =
    account?.tenants.filter(
      (t) => t.role === "admin" && t.kind !== "personal",
    ) ?? [];
  const status = (
    <>
      {!ready ? (
        <div className="au-status" role="status">
          <span className="au-dot" aria-hidden="true" />
          Loading your account…
        </div>
      ) : null}
      {error && <Banner notice={{ tone: "warn", lead: error }} />}
      {ready && !account && (
        <button
          className="au-btn"
          type="button"
          onClick={() => location.reload()}
        >
          Try again
        </button>
      )}
    </>
  );
  // Wait for the account before showing workspace UI, including on old links.
  if (!account || account.showWorkspaces === false)
    return (
      <AuthFrame>
        <section className="au-card" aria-busy={!ready}>
          {account?.showWorkspaces === false ? (
            <p className="au-status" role="status">
              Opening Truex…
            </p>
          ) : (
            status
          )}
        </section>
      </AuthFrame>
    );
  const workspaceList = account && account.tenants.length > 0 && (
    <ul className="au-list">
      {account.tenants.map((t) => (
        <li key={t.id}>
          <button
            className="au-ws"
            type="button"
            disabled={!!busy}
            onClick={() => void choose(t.id)}
            aria-current={account.tenantId === t.id ? "true" : undefined}
          >
            <span className="au-ws-logo" aria-hidden="true">
              {t.name.trim()[0]?.toUpperCase() || "?"}
            </span>
            <span className="au-ws-text">
              <span className="au-ws-name">{t.name}</span>
              <span className="au-ws-sub">
                {busy === t.id
                  ? "Opening…"
                  : t.kind === "personal"
                    ? "Private to you"
                    : "Team workspace"}
                {busy !== t.id &&
                  account.tenantId === t.id &&
                  " · Current workspace"}
              </span>
            </span>
            <span className="au-pill">
              {t.role === "admin" ? "Admin" : "Member"}
            </span>
            {!onboarding && (
              <Icon
                name={account.tenantId === t.id ? "check" : "chevronR"}
                size={18}
              />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
  const signOutButton = (
    <button
      className="au-btn"
      type="button"
      disabled={!!busy}
      onClick={() => void leave()}
    >
      {!onboarding && <Icon name="logout" size={15} />}
      {busy === "logout" ? "Signing out…" : "Sign out"}
    </button>
  );
  if (onboarding)
    return (
      <AuthFrame>
        <section
          className="au-card"
          aria-labelledby="au-title"
          aria-busy={!ready || !!busy}
        >
          <h1 id="au-title">
            Your <em>workspace</em>
          </h1>
          {status}
          {account && (
            <>
              <p className="au-lead">
                Workspaces are created by your administrator. Choose a workspace
                or sign in again to access the default workspace.
              </p>
              {workspaceList}
              {!account.tenants.length && <GoogleButton href={GOOGLE_START} />}
              <div className="au-actions">
                {account.tenantId && (
                  <a className="au-btn" href="/">
                    Back to Truex
                  </a>
                )}
                {signOutButton}
              </div>
            </>
          )}
        </section>
      </AuthFrame>
    );
  return (
    <AuthFrame
      wide
      toolbar={
        <nav className="au-actions" aria-label="Account actions">
          <button
            className="au-btn au-theme"
            type="button"
            onClick={toggle}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            <Icon name={isDark ? "sun" : "moon"} size={17} />
          </button>
          {account?.tenantId && (
            <a className="au-btn" href="/">
              <Icon name="chevronL" size={15} />
              Back to Truex
            </a>
          )}
          {account && signOutButton}
        </nav>
      }
    >
      <header className="au-workspace-header">
        <p className="au-eyebrow">Your account</p>
        <h1 id="au-title">
          Manage <em>workspaces</em>
        </h1>
        <p className="au-lead">
          Switch between your workspaces and manage team invitations.
        </p>
        {account && (
          <p className="au-account-email">
            Signed in as <strong>{account.user.email}</strong>
          </p>
        )}
      </header>
      <div className="au-workspace-status" aria-busy={!ready || !!busy}>
        {status}
      </div>
      {account && (
        <div className="au-workspace-grid">
          <div className="au-workspace-column">
            <section
              className="au-card"
              aria-labelledby="switch-title"
              aria-busy={!!busy}
            >
              <div className="au-panel-heading">
                <span className="au-panel-icon">
                  <Icon name="grid" size={20} />
                </span>
                <div>
                  <h2 className="au-section-title" id="switch-title">
                    Your workspaces
                  </h2>
                  <p className="au-fine">
                    Choose a workspace to open it and start working.
                  </p>
                </div>
                <span
                  className="au-count"
                  aria-label={`${account.tenants.length} workspaces`}
                >
                  {account.tenants.length}
                </span>
              </div>
              {workspaceList || (
                <div className="au-workspace-empty">
                  <Icon name="folder" size={28} />
                  <h3 className="au-section-title">No workspaces yet</h3>
                  <p className="au-fine">
                    Sign in again to access the default workspace, or open an
                    invitation from your team admin.
                  </p>
                  <GoogleButton href={GOOGLE_START} />
                </div>
              )}
              {!!account.tenants.length && (
                <p className="au-workspace-note au-fine">
                  <Icon name="lock" size={14} />
                  Work, conversations and connectors stay within each workspace.
                </p>
              )}
            </section>
            <p className="au-fine">
              Workspaces are created by your administrator. To join another
              team, open its invitation link.
            </p>
          </div>
          {(account.canManageInvites ?? account.canCreate) &&
            admins.length > 0 && (
              <div className="au-workspace-column">
                <WorkspaceInvitations
                  workspaces={admins}
                  currentId={account.tenantId}
                  onSignedOut={signedOutView}
                />
              </div>
            )}
        </div>
      )}
    </AuthFrame>
  );
}
