"use client";
import { useEffect, useState } from "react";
import { AuthFrame, Banner, LoginCard } from "./login-card";
import {
  fetchMe,
  fetchTenants,
  signOut,
  switchWorkspace,
  type WorkspaceRef,
} from "@/lib/session";
import { clearPrivateBrowserState } from "@/lib/identity";
import "@/styles/v2/auth.css";

type View =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "list"; tenants: WorkspaceRef[]; current: string | null }
  | { kind: "none" }
  | { kind: "unavailable"; message: string };

/**
 * /select-tenant: where the platform sends someone with several workspaces.
 * The list comes from the server, and only a workspace on it can be chosen.
 * One workspace means no choice to make, so it opens directly.
 */
export function WorkspaceChooser() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      const [tenants, me] = await Promise.all([fetchTenants(), fetchMe()]);
      if (!live) return;
      if (tenants.kind === "signedOut") return setView({ kind: "signedOut" });
      if (tenants.kind === "unavailable")
        return setView({ kind: "unavailable", message: tenants.message });
      if (!tenants.tenants.length) return setView({ kind: "none" });
      const current = me.kind === "ok" ? me.me.tenant.id : null;
      if (tenants.tenants.length === 1 && current === tenants.tenants[0].id)
        return location.replace("/");
      setView({ kind: "list", tenants: tenants.tenants, current });
    })();
    return () => {
      live = false;
    };
  }, []);

  async function choose(t: WorkspaceRef, current: string | null) {
    if (busy) return;
    setError("");
    if (t.id === current) return location.assign("/");
    setBusy(t.id);
    const result = await switchWorkspace(t.id);
    if (result.ok) {
      // A full load, so nothing of the previous workspace remains in this tab.
      clearPrivateBrowserState();
      return location.assign("/");
    }
    setBusy(null);
    if (result.signedOut) return setView({ kind: "signedOut" });
    setError(result.message);
  }

  if (view.kind === "signedOut") return <LoginCard />;
  return (
    <AuthFrame>
      <section
        className="au-card"
        aria-labelledby="au-title"
        aria-busy={view.kind === "loading"}
      >
        <h1 id="au-title">
          Choose a <em>workspace</em>
        </h1>
        {view.kind === "loading" && (
          <div className="au-status" role="status" aria-live="polite">
            <span className="au-dot" aria-hidden="true" />
            Loading your workspaces…
          </div>
        )}
        {view.kind === "unavailable" && (
          <>
            <Banner notice={{ tone: "warn", lead: view.message }} />
            <div className="au-actions">
              <button
                type="button"
                className="au-btn primary"
                onClick={() => location.reload()}
              >
                Try again
              </button>
            </div>
          </>
        )}
        {view.kind === "none" && (
          <>
            <Banner
              notice={{
                tone: "warn",
                lead: "You aren’t a member of any workspace.",
                rest: "Ask your administrator to invite you.",
              }}
            />
            <div className="au-actions">
              <button
                type="button"
                className="au-btn"
                onClick={() =>
                  void signOut().then(() => {
                    clearPrivateBrowserState();
                    location.replace("/login");
                  })
                }
              >
                Sign out
              </button>
            </div>
          </>
        )}
        {view.kind === "list" && (
          <>
            <p className="au-lead">
              You belong to more than one. Pick where to work; you can switch
              later from your account menu.
            </p>
            {error && <Banner notice={{ tone: "warn", lead: error }} />}
            <ul className="au-list">
              {view.tenants.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="au-ws"
                    onClick={() => void choose(t, view.current)}
                    disabled={!!busy}
                    aria-current={t.id === view.current ? "true" : undefined}
                  >
                    <span className="au-ws-logo" aria-hidden="true">
                      {(t.name.trim()[0] || "?").toUpperCase()}
                    </span>
                    <span className="au-ws-text">
                      <span className="au-ws-name">{t.name}</span>
                      <span className="au-ws-sub">
                        {busy === t.id
                          ? "Opening…"
                          : t.id === view.current
                            ? "Current workspace"
                            : " "}
                      </span>
                    </span>
                    <span className="au-pill">
                      {t.role === "admin" ? "Admin" : "Member"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </AuthFrame>
  );
}
