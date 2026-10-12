"use client";

// Invite acceptance page, left pane (join-tenant-v3-dev-spec.html, "Left pane components" and
// "Page states"), with the user's decisions: the inviter row shows the workspace, Expired is a
// banner only, there is no terms line, and Join goes to Google sign-in with the typed name.
// Styles: styles/v2/invite.css, class names prefixed jp- so the app's global classes can't leak in.

import { useCallback, useEffect, useRef, useState } from "react";
import { CapabilitiesBoard, type BoardProfile } from "./capabilities-board";
import { auraFor } from "@/lib/invite-aura";
import {
  NAME_MAX,
  barPercent,
  checkup,
  clean,
  errorNotice,
  expiryLabel,
  firstName,
  formatDay,
  formatMonth,
  initials,
  inviteKind,
  isValid,
  logoInitial,
  parseLookup,
  roleLabel,
  startUrl,
  ttlCopy,
  type InviteKind,
  type InviteLookup,
  type Notice,
} from "@/lib/invite-form";

type Theme = "" | "light" | "dark";
const THEME_KEY = "truex-theme"; // same key and attribute as useTheme()
const NAME_ERROR = "Add your full name so teammates know who joined.";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "" || t === "light" || t === "dark" ? t : "light";
  } catch {
    return "light";
  }
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function Banner({ notice }: { notice: Notice }) {
  return (
    <div className={`jp-banner ${notice.tone}`} role={notice.tone === "warn" ? "alert" : "status"}>
      {notice.tone === "warn" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 16.5v.5" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
      <div>
        <b>{notice.lead}</b>
        {notice.rest ? ` ${notice.rest}` : null}
      </div>
    </div>
  );
}

export function JoinPage({ token }: { token: string }) {
  const [lookup, setLookup] = useState<InviteLookup | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [params, setParams] = useState<{ joined: boolean; error: string | null; email: string | null }>({
    joined: false,
    error: null,
    email: null,
  });
  const [theme, setTheme] = useState<Theme>("light");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [live, setLive] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch(`/auth/invites/${encodeURIComponent(token)}`, { cache: "no-store" });
      const parsed = res.ok ? parseLookup(await res.json()) : null;
      if (!parsed) throw new Error("bad lookup");
      setLookup(parsed);
    } catch {
      setLoadError(true);
    }
  }, [token]);

  // Query params from the Google callback, read once; ?joined=1 is removed from the URL.
  // The ref guard matters: effects can run twice (React strict mode), and the second run
  // would otherwise read the URL after ?joined=1 was already stripped.
  const paramsRead = useRef(false);
  useEffect(() => {
    if (!paramsRead.current) {
      paramsRead.current = true;
      const q = new URLSearchParams(window.location.search);
      const joined = q.get("joined") === "1";
      setParams({ joined, error: q.get("error"), email: q.get("email") });
      if (q.get("error") === "invalid_name") setNameError(true);
      if (joined) {
        q.delete("joined");
        const rest = q.toString();
        window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
      }
    }
    setTheme(readTheme());
    load();
    // Coming back with the browser's Back button after Join restores this page from cache.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [load]);

  const workspace = lookup?.tenantName ?? "";
  useEffect(() => {
    document.title = workspace ? `Join ${workspace} · truex` : "Join a workspace · truex";
  }, [workspace]);

  function applyTheme(t: Theme) {
    setTheme(t);
    const root = document.documentElement;
    if (t) root.dataset.theme = t;
    else delete root.dataset.theme;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {}
  }

  const kind: InviteKind | null = lookup ? inviteKind(lookup, params.joined, params.error) : null;
  const cleaned = clean(name);
  const nameOk = isValid(cleaned);
  const check = kind ? checkup(kind, nameOk, busy) : null;
  const wrongAccount = kind === "valid" && params.error === "wrong_account";
  const otherError = kind === "valid" ? errorNotice(params.error) : null;
  const expiry = lookup ? expiryLabel(lookup.expiresAt, lookup.serverNow) : null;
  const showForm = kind === "valid";
  const joinedLike = kind === "joined" || kind === "member";

  function notice(): Notice | null {
    if (!lookup || !kind) return null;
    const viewer = lookup.viewer;
    switch (kind) {
      case "joined":
        return { tone: "ok", lead: `You're in, ${firstName(viewer?.name ?? "") || "welcome"}.`, rest: `Your seat in ${workspace} is ready.` };
      case "member":
        return { tone: "ok", lead: `You're already in ${workspace}.`, rest: viewer ? `Signed in as ${viewer.email}.` : undefined };
      case "expired":
        return {
          tone: "warn",
          lead: `This invite expired on ${formatDay(lookup.expiresAt)}.`,
          rest: `${ttlCopy(lookup.ttlDays)} Ask the person who invited you for a new one.`,
        };
      case "used":
      case "revoked":
      case "not_found":
        return { tone: "warn", lead: "This invite link isn't valid anymore.", rest: "Ask the person who invited you for a new one." };
      default:
        if (wrongAccount)
          return {
            tone: "warn",
            lead: `This invite is for ${lookup.email ?? "a different account"}.`,
            rest: `You signed in as ${params.email ?? "another Google account"}. Switch account, then join with the Google account this invite was sent to.`,
          };
        return otherError;
    }
  }

  function profile(): BoardProfile {
    const viewer = lookup?.viewer;
    if (joinedLike && viewer) {
      const n = clean(viewer.name ?? viewer.email.split("@")[0]);
      return {
        name: n,
        initials: initials(n),
        joined: true,
        aura: auraFor(n),
        sub: kind === "joined" ? "joined just now" : viewer.memberSince ? `member since ${formatMonth(viewer.memberSince, lookup!.serverNow)}` : "member",
      };
    }
    if (showForm && cleaned) return { name: cleaned, initials: initials(cleaned), joined: false, aura: auraFor(cleaned), sub: "member" };
    return { name: "", initials: "", joined: false, sub: "seat open" };
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !lookup) return;
    if (joinedLike) {
      setOpening(true);
      setLive(`Opening ${workspace}`);
      window.location.assign("/");
      return;
    }
    if (!nameOk) {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setLive("Verifying your invite");
    window.location.assign(startUrl(token, cleaned));
  }

  async function switchAccount(e: React.MouseEvent) {
    e.preventDefault();
    try {
      await fetch("/auth/logout", { method: "POST" });
    } catch {}
    setParams({ joined: false, error: null, email: null });
    window.history.replaceState(null, "", window.location.pathname);
    setNameError(false);
    setLookup(null);
    load();
  }

  const banner = notice();

  return (
    <div className="join-page">
      <div className="jp-left">
        <header className="jp-top">
          <div className="jp-brand" aria-label="truex agents">
            <span className="jp-brand-mark" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
              </svg>
            </span>
            <span className="jp-brand-word">truex</span>
            <span className="jp-brand-slash" aria-hidden="true">/</span>
            <span className="jp-brand-sub">agents</span>
          </div>
          <div className="jp-seg" role="group" aria-label="Theme">
            {(["", "light", "dark"] as const).map((t) => (
              <button key={t || "auto"} type="button" aria-pressed={theme === t} onClick={() => applyTheme(t)}>
                {t === "" ? "Auto" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </header>

        <main className="jp-invite">
          {loadError ? (
            <>
              <h1>This invite didn&apos;t load</h1>
              <Banner notice={{ tone: "warn", lead: "Couldn't load this invite.", rest: "Check your connection and try again." }} />
              <button type="button" className="jp-btn" onClick={load}>
                Try again
              </button>
            </>
          ) : !lookup || !kind || !check ? (
            <div className="jp-card jp-skeleton" aria-busy="true" aria-label="Loading invite">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <>
              {workspace ? (
                <div className="jp-from" aria-label="Invitation">
                  <span className="jp-ws-logo" aria-hidden="true">
                    {logoInitial(workspace)}
                  </span>
                  <div className="jp-from-text">
                    <div className="jp-from-line">
                      <b>{workspace}</b> invited you as <span className="jp-role-pill">{roleLabel(lookup.role)}</span>
                    </div>
                    {lookup.sentAt ? <div className="jp-from-sub">sent {formatDay(lookup.sentAt)}</div> : null}
                  </div>
                  {expiry && (kind === "valid" || kind === "expired") ? (
                    <span className={`jp-exp${expiry.expired ? " bad" : ""}`}>
                      <span className="jp-tick" aria-hidden="true" />
                      {expiry.text}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <h1 id="jp-h">
                {workspace ? (
                  <>
                    Take your seat at <em>{workspace}</em>
                  </>
                ) : (
                  <>
                    Join a workspace on <em>truex</em>
                  </>
                )}
              </h1>

              <form className="jp-card jp-join" noValidate onSubmit={onSubmit} aria-labelledby="jp-sec-h">
                <div className="jp-eyebrow" id="jp-sec-h">
                  Set up your seat
                </div>

                <div>
                  <div className="jp-check-h">
                    <span>Progress checkup</span>
                    <span className="jp-mono">{check.count} of 3</span>
                  </div>
                  <div
                    className={`jp-bar${check.bad ? " bad" : ""}`}
                    role="progressbar"
                    aria-label="Join progress"
                    aria-valuemin={0}
                    aria-valuemax={3}
                    aria-valuenow={check.count}
                  >
                    <span style={{ width: `${barPercent(check)}%` }} />
                  </div>
                  <ol className="jp-steps">
                    {check.steps.map((s, i) => (
                      <li key={i} className={s.tone}>
                        <span className="jp-dot" aria-hidden="true">
                          {s.glyph}
                        </span>
                        <span>{s.label}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {banner ? <Banner notice={banner} /> : null}

                {showForm ? (
                  <div className="jp-fields">
                    <div className="jp-field">
                      <label className="jp-field-label" htmlFor="jp-email">
                        Email <span className="jp-field-hint">from invite</span>
                      </label>
                      <div className="jp-input-wrap">
                        <svg className="jp-input-lock" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <rect x="4" y="11" width="16" height="10" rx="2" />
                          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                        </svg>
                        <input className="jp-input" id="jp-email" type="email" value={lookup.email ?? ""} readOnly />
                      </div>
                    </div>
                    <div className="jp-field">
                      <label className="jp-field-label" htmlFor="jp-name">
                        Your name{" "}
                        <span className={`jp-field-hint${nameOk ? " ok" : ""}`}>{nameOk ? "looks good" : "shown to teammates"}</span>
                      </label>
                      <div className="jp-input-wrap">
                        <span className={`jp-input-av${cleaned ? " is-set" : ""}`} aria-hidden="true">
                          {cleaned ? initials(cleaned) : "?"}
                        </span>
                        <input
                          ref={nameRef}
                          className="jp-input"
                          id="jp-name"
                          type="text"
                          placeholder="e.g. Alex Rivera"
                          autoComplete="name"
                          maxLength={NAME_MAX}
                          required
                          readOnly={busy}
                          value={name}
                          aria-invalid={nameError || undefined}
                          aria-describedby="jp-name-err"
                          onChange={(e) => {
                            setName(e.target.value);
                            setNameError(false);
                          }}
                        />
                      </div>
                      <div className="jp-err" id="jp-name-err" hidden={!nameError}>
                        {NAME_ERROR}
                      </div>
                    </div>
                  </div>
                ) : null}

                {showForm || joinedLike ? (
                  <button className="jp-btn" type="submit" disabled={busy || opening}>
                    <span>
                      {busy ? "Verifying your invite" : opening ? "Opening…" : joinedLike ? `Open ${workspace}` : `Join ${workspace}`}
                    </span>
                    {busy ? <span className="jp-spin" aria-hidden="true" /> : <Arrow />}
                  </button>
                ) : null}
                <p className="sr-only" aria-live="polite">
                  {live}
                </p>

                <div className="jp-fine">
                  {kind === "used" ? (
                    <span>
                      Already joined? <a href="/login">Sign in</a>
                    </span>
                  ) : (
                    <span />
                  )}
                  <span>
                    Not you?{" "}
                    <a href="#" onClick={switchAccount}>
                      Switch account
                    </a>
                  </span>
                </div>
              </form>
            </>
          )}
        </main>
      </div>

      <CapabilitiesBoard profile={profile()} />
    </div>
  );
}
