"use client";

import { useRef, useState, type FormEvent } from "react";
import { AuthFrame, Banner } from "./login-card";
import { clean, initials, NAME_MAX } from "@/lib/invite-form";
import { auraFor } from "@/lib/invite-aura";
import { saveProfileName, type Me } from "@/lib/session";

const NAME_ERROR =
  "Enter a name with 2 to 60 characters and at least one letter.";

/** One-time name confirmation for new accounts created without an invite. */
export function ProfileNameCard({
  user,
  onSaved,
  onSessionChanged,
  onSignOut,
  signingOut,
}: {
  user: Me["user"];
  onSaved: () => void;
  onSessionChanged: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [name, setName] = useState(user.name ?? "");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const cleaned = clean(name);
  const length = [...cleaned].length;
  const nameOk =
    length >= 2 &&
    length <= NAME_MAX &&
    /\p{L}/u.test(cleaned) &&
    !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(cleaned);
  const count = nameOk ? 2 : 1;
  const steps = [
    { label: "Google verified", tone: "is-done", glyph: "✓" },
    {
      label: "Name added",
      tone: invalid ? "is-bad" : nameOk ? "is-done" : "is-on",
      glyph: invalid ? "!" : nameOk ? "✓" : "2",
    },
    {
      label: "Profile saved",
      tone: busy
        ? "is-busy"
        : error && !invalid
          ? "is-bad"
          : nameOk
            ? "is-on"
            : "",
      glyph: busy ? "" : error && !invalid ? "!" : "3",
    },
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || signingOut) return;
    if (!nameOk) {
      setInvalid(true);
      setError(NAME_ERROR);
      input.current?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    const result = await saveProfileName(user.id, cleaned);
    if (result.ok) {
      onSaved();
      return;
    }
    saving.current = false;
    setBusy(false);
    setError(result.message);
    if (result.signedOut) onSessionChanged();
  }

  return (
    <AuthFrame
      split
      profile={{
        name: cleaned,
        initials: initials(cleaned),
        sub: "your profile",
        joined: false,
        ...(cleaned ? { aura: auraFor(cleaned) } : {}),
      }}
    >
      <p className="au-eyebrow">Finish creating your account</p>
      <h1 id="au-title">
        What should we <em>call you?</em>
      </h1>
      <p className="au-lead">
        Confirm your name before opening Truex. You only need to do this once.
      </p>
      <form
        className="jp-card jp-join"
        onSubmit={submit}
        noValidate
        aria-labelledby="au-profile-heading"
      >
        <div className="jp-eyebrow" id="au-profile-heading">
          Set up your profile
        </div>
        <div>
          <div className="jp-check-h">
            <span>Progress checkup</span>
            <span className="jp-mono">{count} of 3</span>
          </div>
          <div
            className={`jp-bar${error ? " bad" : ""}`}
            role="progressbar"
            aria-label="Profile setup progress"
            aria-valuemin={0}
            aria-valuemax={3}
            aria-valuenow={count}
          >
            <span style={{ width: `${(count / 3) * 100}%` }} />
          </div>
          <ol className="jp-steps">
            {steps.map((step, index) => (
              <li
                key={step.label}
                className={step.tone}
                aria-current={index === (nameOk ? 2 : 1) ? "step" : undefined}
              >
                <span className="jp-dot" aria-hidden="true">
                  {step.glyph}
                </span>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        </div>
        {error && !invalid ? (
          <div id="au-name-error">
            <Banner variant="invite" notice={{ tone: "warn", lead: error }} />
          </div>
        ) : null}
        <div className="jp-fields">
          <div className="jp-field">
            <label className="jp-field-label" htmlFor="au-profile-email">
              Email <span className="jp-field-hint">from Google</span>
            </label>
            <div className="jp-input-wrap">
              <svg
                className="jp-input-lock"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <input
                className="jp-input"
                id="au-profile-email"
                type="email"
                value={user.email}
                readOnly
              />
            </div>
          </div>
          <div className="jp-field">
            <label className="jp-field-label" htmlFor="au-profile-name">
              Your name{" "}
              <span className={`jp-field-hint${nameOk ? " ok" : ""}`}>
                {nameOk ? "looks good" : "your display name"}
              </span>
            </label>
            <div className="jp-input-wrap">
              <span
                className={`jp-input-av${cleaned ? " is-set" : ""}`}
                aria-hidden="true"
              >
                {cleaned ? initials(cleaned) : "?"}
              </span>
              <input
                ref={input}
                className="jp-input"
                id="au-profile-name"
                type="text"
                autoComplete="name"
                placeholder="e.g. Alex Rivera"
                required
                maxLength={NAME_MAX}
                value={name}
                readOnly={busy || signingOut}
                aria-invalid={invalid || undefined}
                aria-describedby={error ? "au-name-error" : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setInvalid(false);
                  setError("");
                }}
              />
            </div>
            {invalid ? (
              <div className="jp-err" id="au-name-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </div>
        <button type="submit" className="jp-btn" disabled={busy || signingOut}>
          <span>{busy ? "Saving your name…" : "Continue to Truex"}</span>
          {busy ? (
            <span className="jp-spin" aria-hidden="true" />
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
        <p className="sr-only" role="status" aria-live="polite">
          {busy ? "Saving your profile" : ""}
        </p>
        <div className="jp-fine">
          <span>Your name is saved once.</span>
          <span>
            Not you?{" "}
            <button
              type="button"
              className="jp-text-action"
              disabled={busy || signingOut}
              onClick={onSignOut}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </span>
        </div>
      </form>
    </AuthFrame>
  );
}
