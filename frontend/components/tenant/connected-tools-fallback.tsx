"use client";
import { useEffect, useState } from "react";
import { callbackErrorMessage, readCallback } from "@/lib/tenant-connectors";
import { Icon } from "@/components/v2/icon";
import "@/styles/v2/connectors.css";

// The fallback landing page for an OAuth callback with no readable flow (no
// tenant context): /connected-tools?error=<code>. It cannot name the
// workspace or the connector reliably, so it shows a calm message and a link
// home. A readable flow always returns to /t/<tenantId>/connected-tools
// instead, so reaching here means something went wrong early.
export function ConnectedToolsFallback() {
  const [message, setMessage] = useState(
    "This sign-in link has already been used or is no longer valid.",
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const outcome = readCallback(window.location.search);
    if (outcome.kind === "error")
      setMessage(callbackErrorMessage(outcome.code));
    else if (outcome.kind === "connected")
      // A bare success with no tenant: send the member home to their workspace.
      setMessage("You're connected. Open your workspace to continue.");
  }, []);

  return (
    <main className="connectors-fallback">
      <div className="connectors-state" role="alert" aria-live="polite">
        <span className="connector-logo" aria-hidden="true">
          <Icon name="plug" size={22} />
        </span>
        <h2>Connected tools</h2>
        <p>{message}</p>
        <a className="btn-solid" href="/">
          Go to your workspace
        </a>
      </div>
    </main>
  );
}
