"use client";
import { useEffect, useState } from "react";
import { AuthFrame, LoginCard } from "./login-card";
import { fetchMe } from "@/lib/session";
import { loginNotice, type LoginNotice } from "@/lib/login";

/**
 * /login. If there is already a session it goes straight into the app, so a
 * signed-in person is never asked to sign in again; otherwise it shows the
 * sign-in card with whatever the last attempt reported in ?error=.
 */
export function LoginScreen() {
  const [notice, setNotice] = useState<LoginNotice | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("error");
    setNotice(loginNotice(code));
    // Remove the code from the address so a reload or a shared link doesn't repeat it.
    if (code) history.replaceState(null, "", location.pathname);
    let live = true;
    void fetchMe().then((result) => {
      if (!live) return;
      // Straight in, unless this page was opened to show why sign-in failed.
      if (result.kind === "ok" && !code) location.replace("/");
      else if (result.kind === "selectTenant" && !code)
        location.replace("/select-tenant");
      else if (result.kind === "onboarding" && !code)
        location.replace("/onboarding");
      else setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  // An error to read is shown at once. Otherwise nothing is offered until the
  // platform has said whether there is a session, so a signed-in person is not
  // shown a sign-in button for the moment before they are sent on.
  if (!ready && !notice)
    return (
      <AuthFrame>
        <div className="au-status" role="status" aria-live="polite">
          <span className="au-dot" aria-hidden="true" />
          Checking your session…
        </div>
      </AuthFrame>
    );
  return <LoginCard notice={notice} />;
}
