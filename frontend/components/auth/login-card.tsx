"use client";
import { useEffect, useState, type ReactNode } from "react";
import { GoogleButton } from "./google-button";
import {
  fetchLoginMethod,
  type LoginMethod,
  type LoginNotice,
} from "@/lib/login";
import "@/styles/v2/auth.css";

export function Banner({ notice }: { notice: LoginNotice }) {
  const warn = notice.tone === "warn";
  return (
    <div
      className={`au-banner ${notice.tone}`}
      role={warn ? "alert" : "status"}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {warn ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6M12 16.5v.5" />
          </>
        ) : (
          <path d="M5 12l5 5 9-10" />
        )}
      </svg>
      <div className="au-banner-body">
        <b>{notice.lead}</b>
        {notice.rest ? ` ${notice.rest}` : null}
      </div>
    </div>
  );
}

export function Brand() {
  return (
    <div className="au-brand">
      <span className="au-mark" aria-hidden="true">
        t
      </span>
      <span className="au-word">truex</span>
    </div>
  );
}

/** Page frame shared by every screen in this family. */
export function AuthFrame({
  children,
  wide = false,
  toolbar,
}: {
  children: ReactNode;
  wide?: boolean;
  toolbar?: ReactNode;
}) {
  return (
    <main className={`au-page${wide ? " au-workspaces" : ""}`}>
      <div className="au-wrap">
        {wide ? (
          <div className="au-top">
            <Brand />
            {toolbar}
          </div>
        ) : (
          <Brand />
        )}
        {children}
      </div>
    </main>
  );
}

/** The one sign-in screen: shown at /login and in place when there is no session. */
export function LoginCard({
  notice,
  action,
}: {
  notice?: LoginNotice | null;
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  const [cookiesOff, setCookiesOff] = useState(false);
  const [method, setMethod] = useState<LoginMethod | null>(null);
  const [methodLoading, setMethodLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setMethodLoading(true);
    void fetchLoginMethod().then((value) => {
      if (live) {
        setMethod(value);
        setMethodLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [attempt]);
  useEffect(
    () =>
      setCookiesOff(
        typeof navigator !== "undefined" && navigator.cookieEnabled === false,
      ),
    [],
  );
  return (
    <AuthFrame>
      <section className="au-card" aria-labelledby="au-title">
        <div>
          <h1 id="au-title">
            Sign in to <em>Truex</em>
          </h1>
        </div>
        <p className="au-lead">
          {method?.kind === "oidc"
            ? "Sign in with your organization’s identity provider."
            : method?.kind === "google"
              ? "Use your Google account. Personal Gmail and Google Workspace accounts both work."
              : "Checking sign-in options…"}
        </p>
        {cookiesOff && (
          <Banner
            notice={{
              tone: "warn",
              lead: "Cookies are blocked in this browser.",
              rest: "Truex needs them to keep you signed in. Allow cookies for this site, then reload.",
            }}
          />
        )}
        {notice && <Banner notice={notice} />}
        {action && (
          <div className="au-actions">
            <button
              type="button"
              className="au-btn primary"
              onClick={action.onClick}
              disabled={action.busy}
            >
              {action.busy ? "Signing out…" : action.label}
            </button>
          </div>
        )}
        {method?.kind === "google" ? (
          <GoogleButton href={method.href} />
        ) : method?.kind === "oidc" ? (
          <a className="au-btn primary" href={method.href}>
            Continue with organization sign-in
          </a>
        ) : methodLoading ? (
          <p role="status">Loading sign-in…</p>
        ) : (
          <div role="alert">
            <p>Sign-in is temporarily unavailable.</p>
            <button className="au-btn" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </section>
      <p className="au-fine center">
        Truex keeps you signed in with a cookie. Signing out of Truex doesn’t
        sign you out of your identity provider.
      </p>
    </AuthFrame>
  );
}
