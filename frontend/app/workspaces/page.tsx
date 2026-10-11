import { WorkspaceManager } from "@/components/auth/workspace-manager";

export const metadata = {
  title: "Manage workspaces · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function WorkspacesPage() {
  return <WorkspaceManager />;
}
