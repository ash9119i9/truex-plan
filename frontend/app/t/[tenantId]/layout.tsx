import type { ReactNode } from "react";
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
