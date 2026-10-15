"use client";
import type { ReactNode } from "react";
import { SessionGate } from "./session-gate";
import { Shell } from "@/components/v2/shell";
import { Icon } from "@/components/v2/icon";
import { useTheme } from "@/lib/use-theme";
import { meKey } from "@/lib/session";
import "@/styles/v2/tenant-workspace.css";

export function TenantWorkspace({
  tenantId,
  children,
}: {
  tenantId: string;
  children: ReactNode;
}) {
  const { isDark, toggle } = useTheme();
  return (
    <SessionGate tenantId={tenantId}>
      {(me, actions) => (
        <Shell key={meKey(me)} className="tenant-workspace is-ready">
          <main className="stage">
            <header className="workspace-header">
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
                <button
                  type="button"
                  className="text-btn"
                  onClick={actions.signOut}
                >
                  Sign out
                </button>
              </div>
            </header>
            {children}
          </main>
        </Shell>
      )}
    </SessionGate>
  );
}
