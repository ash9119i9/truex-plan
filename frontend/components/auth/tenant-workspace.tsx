"use client";
import { createContext, use, useState, type ReactNode } from "react";
import { SessionGate, type SessionActions } from "./session-gate";
import {
  SidebarFrame,
  Topbar,
  type AgentState,
  type SidebarPlace,
} from "./workspace-frame";
import { Shell } from "@/components/v2/shell";
import { meKey, type Me } from "@/lib/session";

const Workspace = createContext<{
  me: Me;
  actions: SessionActions;
  /** Marks the frame as a new conversation (DESIGN-SPEC 11.4). */
  setNew: (isNew: boolean) => void;
} | null>(null);

// Who is signed in to this workspace, for the page inside it.
export function useWorkspace() {
  const workspace = use(Workspace);
  if (!workspace) throw new Error("useWorkspace outside TenantWorkspace");
  return workspace;
}

// The page frame for one workspace (DESIGN-SPEC 11.1). Pages render their own
// sidebar, a WorkspaceStage and side panel; a change of person remounts
// everything below.
export function TenantWorkspace({
  tenantId,
  children,
}: {
  tenantId: string;
  children: ReactNode;
}) {
  const [isNew, setNew] = useState(false);
  return (
    <SessionGate tenantId={tenantId}>
      {(me, actions) => (
        <Workspace value={{ me, actions, setNew }}>
          <Shell key={meKey(me)} isNew={isNew}>
            {children}
          </Shell>
        </Workspace>
      )}
    </SessionGate>
  );
}

// The stage: the topbar, then the page. `topbar` replaces the plain one (an
// open conversation brings its own, with rename and archive).
export function WorkspaceStage({
  title,
  agent,
  start,
  actions,
  topbar,
  children,
}: {
  title: string;
  agent?: { name: string; state: AgentState } | null;
  /** Before everything else in the topbar (the narrow sidebar toggle). */
  start?: ReactNode;
  actions?: ReactNode;
  topbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="cs-stage">
      {topbar ?? (
        <Topbar
          title={title}
          slim={!!agent}
          agent={agent}
          start={start}
          actions={actions}
        />
      )}
      {children}
    </main>
  );
}

// The sidebar's fixed parts for this person and workspace; the page passes
// its history list as children.
export function WorkspaceSidebar({
  current,
  onNew,
  onAgents,
  children,
}: {
  current: SidebarPlace;
  onNew: () => void;
  onAgents?: () => void;
  children?: ReactNode;
}) {
  const { me, actions } = useWorkspace();
  return (
    <SidebarFrame
      tenantId={me.tenant.id}
      user={me.user}
      role={me.role}
      workspace={me.tenant.name}
      current={current}
      onNew={onNew}
      onAgents={onAgents}
      onSignOut={actions.signOut}
    >
      {children}
    </SidebarFrame>
  );
}
