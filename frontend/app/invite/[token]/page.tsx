import { redirect } from "next/navigation";

export const metadata = {
  title: "Sign in · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// Invitations are deferred in platform-next. Retired links enter the supported
// sign-in flow; they never call legacy invitation endpoints or forward tokens.
export default function InvitePage() {
  redirect("/login");
}
