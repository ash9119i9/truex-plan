import { WorkspaceManager } from "@/components/auth/workspace-manager";

export const metadata = {
  title: "Your workspace · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function OnboardingPage() {
  return <WorkspaceManager onboarding />;
}
