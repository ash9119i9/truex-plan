import { WorkspaceChooser } from "@/components/auth/workspace-chooser";

export const metadata = {
  title: "Choose a workspace · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function SelectTenantPage() {
  return <WorkspaceChooser />;
}
