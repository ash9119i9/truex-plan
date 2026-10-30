import type { ReactNode } from "react";
// Before the components, so their own CSS (auth, tools) still comes after it.
import "./workspace.css";
import { TenantWorkspace } from "@/components/auth/tenant-workspace";

export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  return (
    <TenantWorkspace key={tenantId} tenantId={tenantId}>
      {children}
    </TenantWorkspace>
  );
}
