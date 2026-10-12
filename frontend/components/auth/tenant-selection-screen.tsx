"use client";
import { useEffect, useState } from "react";
import { AuthFrame } from "./login-card";
import {
  fetchTenants,
  signOut,
  switchWorkspace,
  type WorkspaceRef,
} from "@/lib/session";

export function TenantSelectionScreen() {
  const [tenants, setTenants] = useState<WorkspaceRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void fetchTenants().then((result) => {
      if (!live) return;
      if (result.kind === "signedOut") location.replace("/login");
      else if (result.kind === "unavailable") setError(result.message);
      else {
        setError(null);
        setTenants(result.tenants);
      }
    });
    return () => {
      live = false;
    };
  }, [attempt]);
  async function choose(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await switchWorkspace(id);
    if (result.ok) location.replace("/");
    else if (result.signedOut) location.replace("/login");
    else {
      setError(result.message);
      setBusy(false);
      setAttempt((v) => v + 1);
    }
  }
  async function end() {
    if (busy) return;
    setBusy(true);
    const result = await signOut();
    if (result.confirmed) location.replace("/login");
    else {
      setError("Sign-out could not be confirmed. Try again.");
      setBusy(false);
    }
  }
  return (
    <AuthFrame>
      <section className="au-card" aria-labelledby="tenant-title">
        <h1 id="tenant-title">Choose a workspace</h1>
        {error && <p role="alert">{error}</p>}
        {tenants === null && !error && (
          <p role="status">Loading your workspaces…</p>
        )}
        {tenants?.length === 0 && (
          <p>
            Your account has no available workspaces. Contact your administrator
            or sign in again.
          </p>
        )}
        {tenants?.map((tenant) => (
          <button
            key={tenant.id}
            type="button"
            className="au-btn"
            disabled={busy}
            onClick={() => void choose(tenant.id)}
          >
            {tenant.name}
          </button>
        ))}
        {error && (
          <button
            type="button"
            className="au-btn"
            disabled={busy}
            onClick={() => setAttempt((v) => v + 1)}
          >
            Try again
          </button>
        )}
        <button
          type="button"
          className="au-btn"
          disabled={busy}
          onClick={() => void end()}
        >
          Sign out
        </button>
      </section>
    </AuthFrame>
  );
}
