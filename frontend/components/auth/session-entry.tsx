"use client";
import { useEffect } from "react";
import { SessionGate } from "./session-gate";
import { AuthFrame } from "./login-card";

function EnterTenant({ tenantId }: { tenantId: string }) {
  useEffect(() => {
    location.replace(`/t/${tenantId}/chat`);
  }, [tenantId]);
  return (
    <AuthFrame>
      <p role="status">Opening your workspace…</p>
    </AuthFrame>
  );
}

/** Shared entry for the root and Google's token-free completion redirect. */
export function SessionEntry() {
  return (
    <SessionGate>{(me) => <EnterTenant tenantId={me.tenant.id} />}</SessionGate>
  );
}
