import { Suspense } from "react";
import { TenantChat } from "@/components/tenant/tenant-chat";

// TenantChat reads the query (?chat=, ?view=) with useSearchParams.
export default function ChatPage() {
  return (
    <Suspense>
      <TenantChat />
    </Suspense>
  );
}
