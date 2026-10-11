import { redirect } from "next/navigation";

export const metadata = {
  title: "Choose a workspace · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function SelectTenantPage() {
  redirect("/workspaces");
}
