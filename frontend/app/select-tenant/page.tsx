import { redirect } from "next/navigation";

export const metadata = {
  title: "Choose a workspace · Truex",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// The tenant chooser is on hold: everyone signs in to the default tenant.
export default function SelectTenantPage() {
  redirect("/");
}
