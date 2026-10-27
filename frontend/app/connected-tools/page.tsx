import { ConnectedToolsFallback } from "@/components/tenant/connected-tools-fallback";

export const metadata = {
  title: "Connected tools · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// /connected-tools — the fallback landing page for an OAuth callback that has
// no readable flow (so it can't be routed to a tenant). A readable flow
// returns to /t/<tenantId>/connected-tools instead.
export default function Page() {
  return <ConnectedToolsFallback />;
}
