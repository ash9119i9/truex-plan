"use client";
import { useEffect, useState, type ReactNode } from "react";
import { GoogleButton } from "./google-button";
import { GOOGLE_START, type LoginNotice } from "@/lib/login";
import { useTheme } from "@/lib/use-theme";
import {
  CapabilitiesBoard,
  type BoardProfile,
} from "@/components/invite/capabilities-board";
import { Button } from "@/components/tx/button";
import { Segmented } from "@/components/tx/segmented";
import { AppMark } from "@/components/tx/app-mark";
import "@/styles/app/auth.css";
import "@/styles/app/capabilities-board.css";

export function Banner({
  notice,
  variant = "auth",
}: {
  notice: LoginNotice;
  variant?: "auth" | "invite";
}) {
  const warn = notice.tone === "warn";
  return (
    <div
      className={`${variant === "invite" ? "jp-banner" : "au-banner"} ${notice.tone}`}
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
      <AppMark />
      <span className="pt-brand-word">truex</span>
    </div>
  );
}

export function LoginTheme() {
  const { theme, setTheme } = useTheme();
  return (
    <Segmented
      label="Theme"
      size="sm"
      options={[
        { value: "auto", label: "Auto" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ]}
      value={theme}
      onChange={setTheme}
    />
  );
}

/** Page frame shared by every screen in this family. */
export function AuthFrame({
  children,
  wide = false,
  split = false,
  toolbar,
  profile,
}: {
  children: ReactNode;
  wide?: boolean;
  split?: boolean;
  toolbar?: ReactNode;
  profile?: BoardProfile;
}) {
  if (split) {
    return (
      <div className="au-page join-page au-login">
        <div className="jp-left">
          <header className="jp-top">
            <div className="au-login-brand">
              <Brand />
              <span className="au-brand-slash" aria-hidden="true">
                /
              </span>
              <span>agents</span>
            </div>
            <LoginTheme />
          </header>
          <main className="jp-invite au-wrap">{children}</main>
        </div>
        {profile ? (
          <CapabilitiesBoard profile={profile} />
        ) : (
          <CapabilitiesBoard variant="login" />
        )}
      </div>
    );
  }
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
  useEffect(
    () =>
      setCookiesOff(
        typeof navigator !== "undefined" && navigator.cookieEnabled === false,
      ),
    [],
  );
  return (
    <AuthFrame split>
      <p className="au-eyebrow">Sign in or create an account</p>
      <h1 id="au-title" className="t-h2">
        Pick up where your <em>agents</em> left off
      </h1>
      <p className="au-lead">
        One Google account, no new password. New here? We set you up in the same
        step.
      </p>
      <section className="au-card" aria-label="Sign in to Truex">
        <p className="au-eyebrow">Continue to truex</p>
        <div className="au-check">
          <div className="au-check-heading">
            <span>Sign-in steps</span>
            <span className="au-counter">0 of 3</span>
          </div>
          <div
            className={`au-progress${notice?.tone === "warn" ? " bad" : ""}`}
            role="progressbar"
            aria-label="Sign-in progress"
            aria-valuenow={0}
            aria-valuemin={0}
            aria-valuemax={3}
          >
            <span />
          </div>
          <ol className="au-steps">
            {["Account", "Access", "Workspace"].map((label, index) => (
              <li
                key={label}
                className={
                  index === 0
                    ? notice?.tone === "warn"
                      ? "is-bad"
                      : "is-on"
                    : undefined
                }
                aria-current={index === 0 ? "step" : undefined}
              >
                <span className="au-step-dot" aria-hidden="true">
                  {index === 0 && notice?.tone === "warn" ? "!" : index + 1}
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        </div>
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
            <Button
              variant="primary"
              onClick={action.onClick}
              working={action.busy ? "Signing out…" : undefined}
            >
              {action.label}
            </Button>
          </div>
        )}
        <GoogleButton href={GOOGLE_START} />
        <p className="au-fine">
          Personal Gmail and Google Workspace accounts both work.
        </p>
      </section>
      <p className="au-fine center">
        Truex keeps you signed in with a cookie. Signing out of Truex doesn’t
        sign you out of Google.
      </p>
    </AuthFrame>
  );
}
