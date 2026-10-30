import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import {
  SHORTCUTS,
  ariaKeys,
  handleShortcut,
  matchShortcut,
  type KeyContext,
} from "../lib/shortcuts.ts";
import { filterPalette, firstOption, moveOption } from "../lib/palette.ts";

const { SidebarFrame } = component("auth/workspace-frame.tsx");
const { CommandPalette } = component("tenant/command-palette.tsx");

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...mods,
  }) as KeyboardEvent;
const mac: KeyContext = { mac: true, inText: false, modal: "none" };
const pc: KeyContext = { mac: false, inText: false, modal: "none" };

test("each chord works with ⌘ on a Mac and Ctrl elsewhere", () => {
  for (const [id, k] of [
    ["new", "j"],
    ["palette", "k"],
    ["sidebar", "b"],
  ] as const) {
    assert.equal(matchShortcut(key(k, { metaKey: true }), mac), id);
    assert.equal(matchShortcut(key(k, { ctrlKey: true }), pc), id);
    // Caps Lock still matches.
    assert.equal(
      matchShortcut(key(k.toUpperCase(), { ctrlKey: true }), pc),
      id,
    );
  }
  assert.equal(matchShortcut(key("j"), mac), null, "a bare letter is typing");
  assert.equal(matchShortcut(key("x", { metaKey: true }), mac), null);
});

test("inside a text field only the platform's own modifier fires", () => {
  const macText = { ...mac, inText: true };
  const pcText = { ...pc, inText: true };
  // ⌘J in the composer is allowed (spec 11.10); Ctrl+K and Ctrl+B are Mac
  // text-editing keys (kill line, back one character) and stay with the field.
  assert.equal(matchShortcut(key("j", { metaKey: true }), macText), "new");
  assert.equal(matchShortcut(key("k", { ctrlKey: true }), macText), null);
  assert.equal(matchShortcut(key("b", { ctrlKey: true }), macText), null);
  assert.equal(matchShortcut(key("b", { ctrlKey: true }), pcText), "sidebar");
  // Outside a field either modifier fires, as aria-keyshortcuts advertises.
  assert.equal(matchShortcut(key("b", { ctrlKey: true }), mac), "sidebar");
});

test("other chords, AltGr and IME composition never fire", () => {
  assert.equal(
    matchShortcut(key("j", { ctrlKey: true, shiftKey: true }), pc),
    null,
  );
  // AltGr on Windows reports Ctrl + Alt.
  assert.equal(
    matchShortcut(key("k", { ctrlKey: true, altKey: true }), pc),
    null,
  );
  assert.equal(
    matchShortcut(key("j", { metaKey: true, ctrlKey: true }), mac),
    null,
  );
  assert.equal(
    matchShortcut(key("j", { metaKey: true, isComposing: true }), mac),
    null,
  );
});

test("a dialog keeps the keys; the palette only takes its own toggle", () => {
  const ev = (k: string) => key(k, { metaKey: true });
  assert.equal(matchShortcut(ev("j"), { ...mac, modal: "other" }), null);
  assert.equal(matchShortcut(ev("k"), { ...mac, modal: "other" }), null);
  assert.equal(matchShortcut(ev("k"), { ...mac, modal: "palette" }), "palette");
  assert.equal(matchShortcut(ev("j"), { ...mac, modal: "palette" }), null);
});

test("holding a chord down fires it once", () => {
  let fired = 0;
  let prevented = 0;
  const run = (repeat: boolean) =>
    handleShortcut(
      {
        ...key("j", { metaKey: true, repeat }),
        preventDefault: () => prevented++,
      } as KeyboardEvent,
      mac,
      { new: () => fired++ },
    );
  assert.equal(run(false), true);
  for (let i = 0; i < 5; i++) assert.equal(run(true), false);
  assert.equal(fired, 1);
  assert.equal(prevented, 1);
});

test("a chord with no handler on the page is left to the browser", () => {
  let prevented = 0;
  const handled = handleShortcut(
    {
      ...key("b", { metaKey: true }),
      preventDefault: () => prevented++,
    } as KeyboardEvent,
    mac,
    { new: () => {} },
  );
  assert.equal(handled, false);
  assert.equal(prevented, 0);
});

test("only bound chords can be advertised", () => {
  // ⌘. arrived with the Activity Panel; ⌘, and ? come with Settings and the sheet.
  assert.deepEqual(Object.keys(SHORTCUTS).sort(), [
    "activity",
    "new",
    "palette",
    "sidebar",
  ]);
  assert.equal(ariaKeys("activity"), "Meta+. Control+.");
  assert.equal(ariaKeys("new"), "Meta+J Control+J");
  assert.equal(ariaKeys("palette"), "Meta+K Control+K");
  assert.equal(ariaKeys("sidebar"), "Meta+B Control+B");

  // Every aria-keyshortcuts goes through ariaKeys(), so it names a chord in
  // the table; no literal strings anywhere in the app.
  const root = resolve(import.meta.dirname, "..");
  const literal: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const text = readFileSync(path, "utf8");
        if (/aria-keyshortcuts=["'{]["'`]?[A-Z]/.test(text)) literal.push(path);
        if (/ariaKeyshortcuts|"aria-keyshortcuts":\s*["'`]/.test(text))
          literal.push(path);
      }
    }
  };
  for (const dir of ["components", "app"]) walk(join(root, dir));
  assert.deepEqual(literal, []);
});

test("New conversation advertises ⌘J and shows its keycap", () => {
  const html = renderToStaticMarkup(
    createElement(SidebarFrame, {
      tenantId: "t1",
      user: { name: "Ada Lovelace", email: "ada@example.com" },
      role: "member",
      workspace: "Default",
      current: "chat",
      onNew: () => {},
      onSignOut: () => {},
    }),
  );
  const button = html.match(/<button[^>]*cs-new[^>]*>.*?<\/button>/)?.[0];
  assert.ok(button, "New conversation button");
  assert.match(button, /aria-keyshortcuts="Meta\+J Control\+J"/);
  assert.match(button, /<kbd class="tx-kbd">⌘J<\/kbd>/);
});

const items = [
  {
    id: "chat:1",
    group: "Go to",
    label: "September close",
    keywords: "ledger",
  },
  { id: "chat:2", group: "Go to", label: "Hiring plan" },
  { id: "new", group: "Actions", label: "New conversation", shortcut: "new" },
  { id: "tools", group: "Actions", label: "Connected tools" },
] as const;

test("the palette filters label and keywords by every word, in groups", () => {
  const all = filterPalette([...items], "");
  assert.deepEqual(
    all.map((g) => [g.group, g.items.map((i) => i.id)]),
    [
      ["Go to", ["chat:1", "chat:2"]],
      ["Actions", ["new", "tools"]],
    ],
  );
  assert.deepEqual(
    filterPalette([...items], "  LEDGER sep ").flatMap((g) =>
      g.items.map((i) => i.id),
    ),
    ["chat:1"],
  );
  assert.deepEqual(filterPalette([...items], "nothing like this"), []);
});

test("palette selection starts on the first safe option and wraps", () => {
  const list = [{ id: "a", danger: true }, { id: "b" }, { id: "c" }];
  assert.equal(firstOption(list), 1);
  assert.equal(firstOption([]), -1);
  assert.equal(moveOption(2, 1, 3), 0);
  assert.equal(moveOption(0, -1, 3), 2);
  assert.equal(moveOption(-1, 1, 0), -1);
});

test("the palette is a modal combobox over a grouped listbox", () => {
  const html = renderToStaticMarkup(
    createElement(CommandPalette, {
      items: [...items],
      onRun: () => {},
      onClose: () => {},
    }),
  );
  assert.match(html, /class="pt-palette-overlay"/);
  assert.match(
    html,
    /role="dialog" aria-modal="true" aria-label="Command palette"/,
  );
  assert.match(html, /role="combobox"[^>]*aria-expanded="true"/);
  const active = html.match(/aria-activedescendant="([^"]+)"/)?.[1];
  assert.ok(active, "an active option");
  assert.match(
    html,
    new RegExp(`id="${active}"[^>]*role="option"[^>]*aria-selected="true"`),
  );
  assert.match(html, /class="pt-palette-group"[^>]*>Go to</);
  assert.match(html, /class="pt-palette-group"[^>]*>Actions</);
  assert.match(html, /<kbd class="tx-kbd">⌘J<\/kbd>/);
  assert.match(html, /navigate/);

  const empty = renderToStaticMarkup(
    createElement(CommandPalette, {
      items: [],
      onRun: () => {},
      onClose: () => {},
    }),
  );
  assert.match(empty, /class="pt-palette-empty"[^>]*>No command matches/);
});
