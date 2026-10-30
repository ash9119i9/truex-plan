import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { component } from "./next-details-runtime.ts";

// The spec 2.3 resolver (lib/theme-boot.ts) and the hook on top of it
// (lib/use-theme.ts), run against a fake browser: one <html> dataset,
// localStorage and matchMedia whose answers the test changes.

const DARK = "(prefers-color-scheme: dark)";
const MORE = "(prefers-contrast: more)";
const REDUCE = "(prefers-reduced-motion: reduce)";

const compile = (path: string) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
const bootSource = compile("../lib/theme-boot.ts");
const hookSource = compile("../lib/use-theme.ts");

function browser({
  storage = {} as Record<string, string>,
  os = {} as { dark?: boolean; more?: boolean; reduce?: boolean },
  blocked = false,
} = {}) {
  const store = new Map(Object.entries(storage));
  const dataset: Record<string, string> = {};
  const media: Record<string, boolean> = {
    [DARK]: !!os.dark,
    [MORE]: !!os.more,
    [REDUCE]: !!os.reduce,
  };
  const handlers = new Map<string, Set<() => void>>();
  const guard = () => {
    if (blocked) throw new Error("Storage blocked");
  };
  // Only what a page has: the boot script must not need anything else.
  const globals = {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem: (key: string) => (guard(), store.get(key) ?? null),
      setItem: (key: string, value: string) => (guard(), store.set(key, value)),
      removeItem: (key: string) => (guard(), store.delete(key)),
    },
    matchMedia(query: string) {
      assert.ok(query in media, `unexpected media query ${query}`);
      const set = handlers.get(query) ?? new Set();
      handlers.set(query, set);
      return {
        get matches() {
          return media[query];
        },
        addEventListener: (_: string, fn: () => void) => set.add(fn),
        removeEventListener: (_: string, fn: () => void) => set.delete(fn),
      };
    },
  };

  let notices = 0;
  let server = false;
  let hook: any;
  function loadHook() {
    const boot = { exports: {} as any };
    runInNewContext(bootSource, { ...globals, exports: boot.exports });
    const module = { exports: {} as any };
    const react = {
      useCallback: (callback: unknown) => callback,
      useSyncExternalStore: (
        subscribe: any,
        snapshot: any,
        serverSnapshot: any,
      ) => {
        if (!server && !hook.subscribed) {
          hook.subscribed = true;
          subscribe(() => notices++);
        }
        return server ? serverSnapshot() : snapshot();
      },
    };
    runInNewContext(hookSource, {
      ...globals,
      exports: module.exports,
      require: (name: string) =>
        name === "react"
          ? react
          : name.endsWith("theme-boot")
            ? boot.exports
            : assert.fail(name),
    });
    return { ...module.exports, boot: boot.exports, subscribed: false };
  }
  hook = loadHook();

  return {
    dataset,
    store,
    script: hook.boot.THEME_BOOT_SCRIPT as string,
    // Runs the serialized <head> script exactly as the page does.
    boot() {
      runInNewContext(this.script, { ...globals });
    },
    read: () => hook.useTheme(),
    serverRead() {
      server = true;
      try {
        return hook.useTheme();
      } finally {
        server = false;
      }
    },
    os(query: string, matches: boolean) {
      media[query] = matches;
      handlers.get(query)?.forEach((fn) => fn());
    },
    notices: () => notices,
  };
}

const effective = (dataset: Record<string, string>) => ({
  theme: dataset.theme,
  contrast: dataset.contrast,
  textsize: dataset.textsize,
  effTheme: dataset.effTheme,
  effContrast: dataset.effContrast,
  effMotion: dataset.effMotion,
});

test("with nothing saved, the boot script follows the OS theme, contrast and motion", () => {
  for (const dark of [false, true])
    for (const more of [false, true])
      for (const reduce of [false, true]) {
        const page = browser({ os: { dark, more, reduce } });
        page.boot();
        assert.deepEqual(effective(page.dataset), {
          theme: "auto",
          contrast: "system",
          textsize: undefined,
          effTheme: dark ? "dark" : "light",
          effContrast: more ? "more" : "normal",
          effMotion: reduce ? "reduce" : "full",
        });
        assert.equal(page.store.size, 0, "a default is not written to storage");
      }
});

test("a saved choice wins over the OS", () => {
  const page = browser({
    storage: {
      "tx-sys-theme": "light",
      "tx-sys-contrast": "normal",
      "tx-sys-size": "200",
    },
    os: { dark: true, more: true },
  });
  page.boot();
  assert.deepEqual(effective(page.dataset), {
    theme: "light",
    contrast: "normal",
    textsize: "200",
    effTheme: "light",
    effContrast: "normal",
    effMotion: "full",
  });

  const dark = browser({
    storage: { "tx-sys-theme": "dark", "tx-sys-contrast": "more" },
  });
  dark.boot();
  assert.equal(dark.dataset.effTheme, "dark");
  assert.equal(dark.dataset.effContrast, "more");
});

test("invalid saved values fall back to the defaults", () => {
  const page = browser({
    storage: {
      "tx-sys-theme": "purple",
      "tx-sys-contrast": "max",
      "tx-sys-size": "100",
    },
    os: { dark: true },
  });
  page.boot();
  assert.equal(page.dataset.theme, "auto");
  assert.equal(page.dataset.contrast, "system");
  assert.equal(
    page.dataset.textsize,
    undefined,
    "100% is the absent attribute",
  );
  assert.equal(page.dataset.effTheme, "dark");
});

test("OS changes re-resolve only what is left to the OS", () => {
  const auto = browser();
  auto.boot();
  auto.os(DARK, true);
  auto.os(MORE, true);
  auto.os(REDUCE, true);
  assert.equal(auto.dataset.effTheme, "dark");
  assert.equal(auto.dataset.effContrast, "more");
  assert.equal(auto.dataset.effMotion, "reduce");

  const pinned = browser({
    storage: { "tx-sys-theme": "light", "tx-sys-contrast": "normal" },
  });
  pinned.boot();
  pinned.os(DARK, true);
  pinned.os(MORE, true);
  assert.equal(pinned.dataset.effTheme, "light");
  assert.equal(pinned.dataset.effContrast, "normal");
});

test("blocked storage falls back to auto without throwing, and the toggle still works", () => {
  const page = browser({ blocked: true, os: { dark: true } });
  assert.doesNotThrow(() => page.boot());
  assert.equal(page.dataset.theme, "auto");
  assert.equal(page.dataset.effTheme, "dark");
  assert.equal(page.read().theme, "auto");
  assert.equal(page.read().isDark, true);
  assert.doesNotThrow(() => page.read().toggle());
  assert.equal(page.dataset.theme, "light");
  assert.equal(page.dataset.effTheme, "light");
  page.os(DARK, false);
  page.os(DARK, true);
  assert.equal(
    page.dataset.effTheme,
    "light",
    "an in-session choice survives OS changes",
  );
});

test("a saved truex-theme moves once to tx-sys-theme and the old key is removed", () => {
  for (const [old, next] of [
    ["dark", "dark"],
    ["light", "light"],
    ["", "auto"],
    ["nonsense", "auto"],
  ]) {
    const page = browser({
      storage: { "truex-theme": old },
      os: { dark: false },
    });
    page.boot();
    assert.equal(
      page.store.get("tx-sys-theme"),
      next,
      `truex-theme=${JSON.stringify(old)}`,
    );
    assert.equal(page.store.has("truex-theme"), false);
    assert.equal(page.dataset.theme, next);
    page.boot();
    assert.deepEqual(
      [...page.store],
      [["tx-sys-theme", next]],
      "a second boot changes nothing",
    );
  }
  const both = browser({
    storage: { "truex-theme": "dark", "tx-sys-theme": "light" },
  });
  both.boot();
  assert.deepEqual(
    [...both.store],
    [["tx-sys-theme", "light"]],
    "the new key wins",
  );
});

test("the hook reads the root, and a choice writes storage and the resolved theme", () => {
  const page = browser({ os: { dark: true } });
  page.boot();
  assert.equal(page.read().theme, "auto");
  assert.equal(page.read().isDark, true);

  page.read().toggle();
  assert.equal(page.store.get("tx-sys-theme"), "light");
  assert.equal(page.dataset.theme, "light");
  assert.equal(page.dataset.effTheme, "light");
  assert.equal(page.read().isDark, false);
  assert.ok(page.notices() > 0);

  page.read().setTheme("auto");
  assert.equal(page.store.get("tx-sys-theme"), "auto");
  assert.equal(page.read().isDark, true);
  const before = page.notices();
  page.os(DARK, false);
  assert.equal(page.read().isDark, false);
  assert.ok(page.notices() > before, "an OS change re-renders callers");
});

test("the server renders Auto, and leaves the root attributes to the boot script", () => {
  assert.deepEqual(
    (({ theme, isDark }) => ({ theme, isDark }))(
      browser({ os: { dark: true } }).serverRead(),
    ),
    { theme: "auto", isDark: false },
  );
  const { default: RootLayout } = component("../app/layout.tsx");
  const html = renderToStaticMarkup(
    createElement(RootLayout, { children: null }),
  );
  assert.match(
    html,
    /^<html lang="en">/,
    "no theme attribute to disagree with the script",
  );
  const at = html.indexOf(`<script>${browser().script}</script>`);
  assert.ok(at > html.indexOf("<head>"), "the resolver is inline in <head>");
  assert.ok(
    at < html.indexOf("<body"),
    "it runs before the body is parsed, so the first paint is themed",
  );

  const { JoinPage } = component("invite/join-page.tsx");
  const invite = renderToStaticMarkup(
    createElement(JoinPage, { token: "test" }),
  );
  assert.match(invite, /aria-checked="true"[^>]*>Auto<\/button>/);
  const { AuthFrame } = component("auth/login-card.tsx");
  const login = renderToStaticMarkup(
    createElement(AuthFrame, { split: true, children: null }),
  );
  assert.match(login, /aria-checked="true"[^>]*>Auto<\/button>/);
});
