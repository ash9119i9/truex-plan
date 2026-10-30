import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { layoutWidth, FOLD } from "../lib/layout-width.ts";

const css = (file: string) =>
  readFileSync(new URL(`../styles/app/${file}`, import.meta.url), "utf8");

// DESIGN-SPEC 11.11 and law 10: the shell folds by the room it has at the
// current text size. At 200% a 1440px window holds what 720px holds at 100%.
test("layout width is the window measured in 100%-text pixels", () => {
  assert.equal(layoutWidth(1440, 16), 1440);
  assert.equal(layoutWidth(1440, 32), 720);
  assert.equal(layoutWidth(1440, 24), 960);
  // a broken or missing root size falls back to the window itself
  assert.equal(layoutWidth(1024, 0), 1024);
  assert.equal(layoutWidth(1024, Number.NaN), 1024);
});

test("the folds follow spec 11.11", () => {
  assert.equal(FOLD.sidebar, 880);
  assert.equal(FOLD.activity, 1080);
});

test("the chat shell folds through the app container, never a px media query", () => {
  // container queries resolve rem against the root font, so they follow text size
  assert.match(
    css("shell.css"),
    /body\s*\{[^}]*container:\s*app\s*\/\s*inline-size/,
  );
  for (const file of [
    "shell.css",
    "composer.css",
    "turn.css",
    "files.css",
    "request.css",
    "activity-panel.css",
    "dock.css",
  ])
    assert.doesNotMatch(
      css(file),
      /@media[^{]*\b(min|max)-width/,
      `${file} still folds on the window width`,
    );
  // the sidebar becomes a drawer at 880 (55rem) and the panel floats at 1080 (67.5rem)
  assert.match(css("shell.css"), /@container app \(max-width: 55rem\)/);
  assert.match(
    css("activity-panel.css"),
    /@container app \(max-width: 67\.5rem\)/,
  );
});

test("the chat screen decides narrow from the layout width, matching the CSS fold", () => {
  const source = readFileSync(
    new URL("../components/tenant/tenant-chat.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /max-width: 720px/);
  assert.match(source, /useLayoutWidth\(\)/);
  assert.match(source, /FOLD\.sidebar/);
});

test("the Activity Panel and its dock key exist only above the activity fold", () => {
  const chat = readFileSync(
    new URL("../components/tenant/tenant-chat.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chat, /activityFits = layoutW > FOLD\.activity/);
  assert.match(chat, /onActivity=\{canActivity \? toggleActivity : undefined\}/);
  assert.match(chat, /activityMounted && shownThread && activityFits &&/);
  // the dock is the one Activity toggle (11.3, 11.9): none in the topbar
  const topbar = readFileSync(
    new URL("../components/tenant/chat-topbar.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(topbar, /\bpanel\b/);
  // the CSS twin hides the panel at 1080 instead of floating it
  assert.match(
    css("activity-panel.css"),
    /@container app \(max-width: 67\.5rem\)\s*\{\s*\.ap\s*\{\s*display: none;/,
  );
  assert.doesNotMatch(css("activity-panel.css"), /position: fixed/);
});
