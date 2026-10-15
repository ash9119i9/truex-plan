import { SessionEntry } from "@/components/auth/session-entry";

export const metadata = {
  title: "Signing in · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function AuthCompletePage() {
  return <SessionEntry />;
}
