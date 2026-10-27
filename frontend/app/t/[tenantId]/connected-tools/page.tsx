import { ConnectedToolsPage } from "@/components/tenant/connected-tools-page";

// /t/<tenantId>/connected-tools — the member's directory connectors, and the
// landing page for the OAuth callback (?connected / ?error). Inside the tenant
// layout, so the workspace session gate wraps it.
export default function Page({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  return <ConnectedToolsPage params={params} />;
}
