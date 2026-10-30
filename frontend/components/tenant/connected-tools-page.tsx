"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import {
  WorkspaceSidebar,
  WorkspaceStage,
} from "@/components/auth/tenant-workspace";
import { Panel } from "@/components/v2/shell";
import { ConnectedTools } from "./connected-tools-screen";

// The tenant Connected tools page body: the workspace sidebar and stage with
// the connectors screen inside. The OAuth callback returns to this route with
// ?connected=<slug> or ?error=<code>&connector=<slug>, which the screen reads.
export function ConnectedToolsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = use(params);
  const router = useRouter();
  return (
    <>
      {/* Wide screens only for now; the narrow drawer comes with spec 11.11. */}
      <Panel
        kind="sidebar"
        open
        label="Conversations and workspace"
        className="cs-sidebar-wide"
      >
        <WorkspaceSidebar
          current="tools"
          onNew={() => router.push(`/t/${tenantId}/chat`)}
        />
      </Panel>
      <WorkspaceStage title="Connected tools">
        <ConnectedTools tenantId={tenantId} />
      </WorkspaceStage>
    </>
  );
}
