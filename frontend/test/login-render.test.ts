import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import { loginNotice } from "../lib/login.ts";

const { LoginCard, AuthFrame } = component("auth/login-card.tsx");
const { CapabilitiesBoard } = component("invite/capabilities-board.tsx");
const render = (Component: any, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Component, props));

test("login uses the split design and the existing Google authentication endpoint", () => {
  const html = render(LoginCard);
  assert.match(html, /au-page join-page au-login/);
  assert.match(html, /Pick up where your <em>agents<\/em> left off/);
  assert.match(html, /href="\/auth\/google\/start"/);
  assert.match(html, /Continue with Google/);
  assert.match(html, /aria-label="Theme"/);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /aria-valuemax="3"/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /Personal Gmail and Google Workspace accounts both work/);
  assert.match(html, /Signing out of Truex doesn’t sign you out of Google/);
  assert.doesNotMatch(
    html,
    /<span>Your name<\/span>|Use SAML|Preview state|href="#"/,
  );
});

test("login preserves auth errors and sign-out retry, including the busy state", () => {
  const html = render(LoginCard, {
    notice: loginNotice("logout_failed"),
    action: { label: "Try signing out again", onClick() {}, busy: true },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /session may still be active/);
  assert.match(html, /Signing out…/);
  assert.match(html, /disabled=""/);
  assert.match(html, /href="\/auth\/google\/start"/);
  assert.match(html, /au-progress bad/);
  const signedOut = render(LoginCard, { notice: loginNotice("signed_out") });
  assert.match(signedOut, /role="status"/);
  assert.doesNotMatch(signedOut, /au-progress bad/);
});

test("login board stays public and the join board preserves its live profile", () => {
  const html = render(CapabilitiesBoard, { variant: "login" });
  assert.match(html, /Eight things you can do once you sign in/);
  assert.match(html, /TRUEX · 08 CAPABILITIES/);
  assert.match(html, />YOU<\/span>/);
  assert.match(html, /Shared threads/);
  assert.match(html, /invite your team/);
  assert.match(html, /set up in a minute/);
  assert.match(html, /truex-signin-v1/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /seat open|truex-invite-v3/);
  const join = render(CapabilitiesBoard, {
    profile: { name: "Dhaya", initials: "D", sub: "ready", joined: true },
  });
  assert.match(join, /Dhaya/);
  assert.match(join, /truex-invite-v3/);
  assert.match(join, /Eight things waiting on the other side/);
});

test("other auth screens retain their original frame", () => {
  const html = render(AuthFrame, {
    children: createElement("p", null, "Existing screen"),
  });
  assert.match(html, /^<main class="au-page">/);
  assert.match(html, /Existing screen/);
  assert.doesNotMatch(html, /au-login|Capabilities|Sign-in steps/);
  assert.match(render(AuthFrame, { wide: true }), /au-page au-workspaces/);
});
