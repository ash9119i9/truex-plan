import { JoinPage } from "@/components/invite/join-page";
import "@/styles/v2/invite-board.css";
import "@/styles/v2/invite.css";

// The token is in the URL, so the page never sends a Referer (fonts, Google) and is never indexed.
export const metadata = {
  title: "Join a workspace · truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinPage token={token} />;
}
