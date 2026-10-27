"use client";
import { use } from "react";
import { WorkspaceStage } from "@/components/auth/tenant-workspace";
import { ConnectedTools } from "./connected-tools-screen";

// The tenant Connected tools page body: the workspace stage with the
// connectors screen inside it. The OAuth callback returns to this route with
// ?connected=<slug> or ?error=<code>&connector=<slug>, which the screen reads.
export function ConnectedToolsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = use(params);
  return (
    <WorkspaceStage>
      <ConnectedTools tenantId={tenantId} />
    </WorkspaceStage>
  );
}
