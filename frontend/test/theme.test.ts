import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { component } from "./next-details-runtime.ts";

const compiled = ts.transpileModule(
  readFileSync(new URL("../lib/use-theme.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function themeRuntime(
  saved: string | null,
  darkSystem: boolean,
  blockedStorage = false,
) {
  const dataset: Record<string, string> = { theme: "light" };
  let stored = saved;
  let dark = darkSystem;
  let subscribed: (() => void) | undefined;
  let notices = 0;
  let server = false;
  const context = {
    exports: {} as any,
    document: { documentElement: { dataset } },
    localStorage: {
      getItem(key: string) {
        assert.equal(key, "truex-theme");
        if (blockedStorage) throw new Error("Storage blocked");
        return stored;
      },
      setItem(key: string, value: string) {
        assert.equal(key, "truex-theme");
        if (blockedStorage) throw new Error("Storage blocked");
        stored = value;
      },
    },
    matchMedia() {
      return {
        matches: dark,
        addEventListener(_name: string, listener: () => void) {
          subscribed = listener;
        },
        removeEventListener() {},
      };
    },
    require() {
      return {
        useCallback: (callback: unknown) => callback,
        useSyncExternalStore: (
          subscribe: any,
          snapshot: any,
          serverSnapshot: any,
        ) => {
          if (!subscribed && !server) subscribe(() => notices++);
          return server ? serverSnapshot() : snapshot();
        },
      };
    },
  };
  runInNewContext(compiled, context);
  return {
    boot() {
      runInNewContext(context.exports.THEME_BOOT_SCRIPT, context);
    },
    read: () => context.exports.useTheme(),
    serverRead() {
      server = true;
      const value = context.exports.useTheme();
      server = false;
      return value;
    },
    system(value: boolean) {
      dark = value;
      subscribed?.();
    },
    stored: () => stored,
    notices: () => notices,
    dataset,
  };
}

test("a fresh browser defaults to light even when the operating system is dark", () => {
  for (const darkSystem of [false, true]) {
    const theme = themeRuntime(null, darkSystem);
    theme.boot();
    assert.equal(theme.dataset.theme, "light");
    assert.equal(theme.read().theme, "light");
    assert.equal(theme.read().isDark, false);
    assert.equal(
      theme.stored(),
      null,
      "a default does not overwrite preferences",
    );
  }
});

test("invalid or inaccessible storage falls back to light", () => {
  for (const [saved, blocked] of [
    ["invalid", false],
    [null, true],
  ] as const) {
    const theme = themeRuntime(saved, true, blocked);
    theme.boot();
    assert.equal(theme.dataset.theme, "light");
    assert.equal(theme.read().theme, "light");
    assert.equal(theme.read().isDark, false);
    theme.read().toggle();
    assert.equal(
      theme.dataset.theme,
      "dark",
      "the toggle works even without storage",
    );
  }
});

test("saved light and dark choices survive boot and the existing toggle", () => {
  for (const saved of ["light", "dark"]) {
    const theme = themeRuntime(saved, saved === "light");
    theme.boot();
    assert.equal(theme.dataset.theme, saved);
    assert.equal(theme.read().isDark, saved === "dark");
    theme.read().toggle();
    const next = saved === "light" ? "dark" : "light";
    assert.equal(theme.stored(), next);
    assert.equal(theme.dataset.theme, next);
    assert.ok(theme.notices() > 0);
  }
});

test("explicit Auto still follows operating-system changes and can be selected from Light", () => {
  const theme = themeRuntime("", true);
  theme.boot();
  assert.equal(theme.dataset.theme, undefined);
  assert.equal(theme.read().theme, "");
  assert.equal(theme.read().isDark, true);
  theme.system(false);
  assert.equal(theme.read().isDark, false);
  theme.read().setTheme("light");
  assert.equal(theme.dataset.theme, "light");
  theme.read().setTheme("");
  assert.equal(theme.stored(), "");
  assert.equal(theme.dataset.theme, undefined);
  theme.system(true);
  assert.equal(theme.read().isDark, true);
});

test("server output defaults to light before scripts or hydration run", () => {
  assert.equal(themeRuntime(null, true).serverRead().theme, "light");
  const { default: RootLayout } = component("../app/layout.tsx");
  const html = renderToStaticMarkup(
    createElement(RootLayout, { children: null }),
  );
  assert.match(html, /<html[^>]*data-theme="light"/);
  const { JoinPage } = component("invite/join-page.tsx");
  const invite = renderToStaticMarkup(
    createElement(JoinPage, { token: "test" }),
  );
  assert.match(invite, /aria-pressed="true">Light<\/button>/);
});
