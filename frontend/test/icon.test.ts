import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import type { IconName } from "../components/tx/icon.tsx";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM = join(FRONTEND, "..", "system");
const { Icon, IconSprite, GLYPHS } = component("tx/icon.tsx");
const html = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Icon, props));
const squash = (s: string) =>
  s.replace(/\s+/g, " ").replace(/> </g, "><").trim();

const sources = (dir: string): string[] =>
  readdirSync(join(FRONTEND, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(FRONTEND, path)).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

test("every icon name the app uses has a glyph in the sprite", () => {
  const used = new Set<string>();
  for (const file of [...sources("components"), ...sources("app")]) {
    const src = readFileSync(join(FRONTEND, file), "utf8");
    for (const m of src.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/g))
      used.add(m[1]);
    for (const m of src.matchAll(
      /<Icon\b[\s\S]*?\bname=\{([\s\S]*?)\}\s*(?:size|className|label|\/>)/g,
    ))
      for (const lit of m[1].matchAll(/(?:^|[?:])\s*"([a-z][a-z0-9-]*)"/g))
        used.add(lit[1]);
  }
  assert.ok(used.size > 10, `found ${used.size} names`);
  const missing = [...used].filter((name) => !(name in GLYPHS));
  assert.deepEqual(missing, []);
  const sprite = renderToStaticMarkup(createElement(IconSprite));
  for (const name of Object.keys(GLYPHS))
    assert.ok(sprite.includes(`id="i-${name}"`), `sprite lacks i-${name}`);
});

test("the five chat glyphs use the rev-02 continuous hand", () => {
  const page = readFileSync(join(SYSTEM, "icon-foundations.html"), "utf8");
  for (const name of ["run", "agent", "trace", "tool", "search"]) {
    const drawn = page.match(
      new RegExp(
        `<symbol id="n-${name}" viewBox="0 0 24 24">([\\s\\S]*?)</symbol>`,
      ),
    );
    assert.ok(drawn, `n-${name} in icon-foundations.html`);
    const [source, markup] = GLYPHS[name];
    assert.equal(source, "rev02", name);
    assert.equal(squash(markup), squash(drawn[1]), name);
  }
});

test("decorative icons are hidden; labelled icons have an accessible name", () => {
  const decorative = html({ name: "check" });
  assert.match(decorative, /aria-hidden="true"/);
  assert.match(decorative, /focusable="false"/);
  assert.match(decorative, /<use href="#i-check"/);
  assert.match(decorative, /class="tx-ic"/);
  assert.doesNotMatch(decorative, /role=/);

  const labelled = html({ name: "x", label: "Close", size: "sm" });
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Close"/);
  assert.doesNotMatch(labelled, /aria-hidden/);
  assert.match(labelled, /class="tx-ic tx-ic-sm"/);

  const sprite = renderToStaticMarkup(createElement(IconSprite));
  assert.match(sprite, /^<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
});

// Compiled by `npm run typecheck`: an unknown name must not type-check.
// @ts-expect-error "nope" is not an icon name
export const unknownIcon: IconName = "nope";

test("lucide-react is gone: icons come only from the system sprite", () => {
  const pkg = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8"));
  assert.equal(
    "lucide-react" in { ...pkg.dependencies, ...pkg.devDependencies },
    false,
  );
  for (const file of [
    ...sources("components"),
    ...sources("app"),
    ...sources("lib"),
  ])
    assert.doesNotMatch(
      readFileSync(join(FRONTEND, file), "utf8"),
      /lucide-react/,
      file,
    );
});
