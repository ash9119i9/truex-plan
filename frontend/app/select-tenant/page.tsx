import { TenantSelectionScreen } from "@/components/auth/tenant-selection-screen";

export const metadata = {
  title: "Choose a workspace · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function SelectTenantPage() {
  return <TenantSelectionScreen />;
}
