"use client";
import { createContext, use, type ReactNode } from "react";
import { SessionGate, type SessionActions } from "./session-gate";
import { Shell } from "@/components/v2/shell";
import { Icon } from "@/components/v2/icon";
import { useTheme } from "@/lib/use-theme";
import { meKey, type Me } from "@/lib/session";
import "@/styles/v2/tenant-workspace.css";

const Workspace = createContext<{ me: Me; actions: SessionActions } | null>(
  null,
);

// Who is signed in to this workspace, for the page inside it.
export function useWorkspace() {
  const workspace = use(Workspace);
  if (!workspace) throw new Error("useWorkspace outside TenantWorkspace");
  return workspace;
}

// The page frame for one workspace. Pages render their own panels and a
// WorkspaceStage; a change of person remounts everything below.
export function TenantWorkspace({
  tenantId,
  children,
}: {
  tenantId: string;
  children: ReactNode;
}) {
  return (
    <SessionGate tenantId={tenantId}>
      {(me, actions) => (
        <Workspace value={{ me, actions }}>
          <Shell key={meKey(me)} className="tenant-workspace is-ready">
            {children}
          </Shell>
        </Workspace>
      )}
    </SessionGate>
  );
}

// The stage: the workspace header, then the page. `start` goes before the
// wordmark (a sidebar toggle, for example).
export function WorkspaceStage({
  start,
  children,
}: {
  start?: ReactNode;
  children: ReactNode;
}) {
  const { me, actions } = useWorkspace();
  const { isDark, toggle } = useTheme();
  return (
    <main className="stage">
      <header className="workspace-header">
        {start}
        <a
          className="brand-word sm"
          href={`/t/${me.tenant.id}/chat`}
          aria-label="Truex chat"
        >
          truex
        </a>
        <span className="workspace-name">{me.tenant.name}</span>
        <div className="workspace-actions">
          <span className="workspace-person" title={me.user.email}>
            {me.user.name}
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={toggle}
            aria-label={
              isDark ? "Switch to light theme" : "Switch to dark theme"
            }
          >
            <Icon name={isDark ? "sun" : "moon"} size={16} />
          </button>
          <button type="button" className="text-btn" onClick={actions.signOut}>
            Sign out
          </button>
        </div>
      </header>
      {children}
    </main>
  );
}
