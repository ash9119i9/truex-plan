import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { LoginCard, AuthFrame } = component("auth/login-card.tsx");
const frontend = new URL("..", import.meta.url);

test("sign-in uses the system's controls: tx buttons and a roving theme segmented control", () => {
  const html = renderToStaticMarkup(
    createElement(LoginCard, { action: { label: "Sign out", onClick() {} } }),
  );
  assert.match(html, /role="radiogroup" aria-label="Theme"/);
  assert.match(html, /class="tx-seg tx-seg-sm"/);
  assert.match(html, /class="tx-btn tx-primary"[^>]*>Sign out</);
  assert.doesNotMatch(html, /au-btn|jp-seg|jp-btn/);
  // the headline uses a type role, its accent from the role's em rule
  assert.match(html, /<h1 id="au-title" class="t-h2">/);
});

test("the old auth and invite stylesheets are gone; the new one is tokens only", () => {
  for (const file of [
    "auth.css",
    "invite.css",
    "invite-board.css",
    "session.css",
  ])
    assert.equal(
      existsSync(new URL(`styles/v2/${file}`, frontend)),
      false,
      file,
    );
  assert.match(
    readFileSync(new URL("test/design-system.test.ts", frontend), "utf8"),
    /"styles\/app\/auth\.css"/,
  );
  const html = renderToStaticMarkup(
    createElement(AuthFrame, { wide: true }, "x"),
  );
  assert.match(html, /au-page au-workspaces/);
});
