import assert from "node:assert/strict";
import test from "node:test";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SYSTEM_FILES,
  driftedFiles,
  rawValues,
} from "./support/design-system.ts";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const SYSTEM = join(FRONTEND, "..", "system");
const COPIES = join(FRONTEND, "styles", "system");
const source = (file: string) => readFileSync(join(SYSTEM, file), "utf8");

// Product CSS held to the tokens-only law. Each ported screen adds its files.
const TOKENS_ONLY: string[] = [
  "styles/app/shell.css",
  "styles/app/composer.css",
  "styles/app/dock.css",
  "styles/app/turn.css",
  "styles/app/files.css",
  "styles/app/request.css",
  "styles/app/activity-panel.css",
  "styles/app/agents.css",
  "styles/app/agent-desk.css",
  "styles/app/goal.css",
  "styles/app/auth.css",
  "styles/app/tools.css",
  "styles/app/viewer.css",
  "styles/app/errors.css",
  "styles/app/utilities.css",
  "styles/app/reset.css",
];

test("the app's system CSS copies match system/ byte for byte", () => {
  assert.deepEqual(driftedFiles(SYSTEM, COPIES), []);
});

test("one changed byte in a copy is reported as drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "tx-drift-"));
  try {
    for (const file of SYSTEM_FILES)
      cpSync(join(SYSTEM, file), join(dir, file));
    assert.deepEqual(driftedFiles(SYSTEM, dir), []);
    const css = readFileSync(join(dir, "space.css"));
    css[css.length - 2] ^= 1;
    writeFileSync(join(dir, "space.css"), css);
    rmSync(join(dir, "corner.css"));
    assert.deepEqual(driftedFiles(SYSTEM, dir), ["space.css", "corner.css"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raw hex, spacing, font-size, radius and shadow are reported", () => {
  const found = rawValues(`
    .a { color: #3691cd; }
    .b { padding: var(--sp-2) 10px; }
    .c { font-size: .75rem; }
    .d { border-radius: 8px; }
    .e { box-shadow: 0 1px 2px rgb(0 0 0 / 5%); }
    .f { gap: 6px; }
    .g { font: 500 12px/1 var(--f-mono); }
    .h { --tint: #fff; }
  `);
  assert.deepEqual(
    found.map((v) => `${v.selector} ${v.property}`),
    [
      ".a color",
      ".b padding",
      ".c font-size",
      ".d border-radius",
      ".e box-shadow",
      ".f gap",
      ".g font",
      ".h --tint",
    ],
  );
});

test("tokens, zero, circles and the 19.1 exceptions pass", () => {
  const found = rawValues(`
    .a { /* fallback: #fff, padding: 12px */ color: var(--ink); padding: 0 var(--sp-3); gap: var(--sp-1); }
    .b { font-size: var(--t-meta); border-radius: 50%; box-shadow: var(--sh-2); }
    .c { box-shadow: none; margin: calc(var(--sp-2) * -1); width: 1px; }
    .d { border-radius: var(--r-lg); }
    .cs-dock .key { width: 40px; gap: 12px; }
    .e { --pb-ink: #1f2a30; --dock-shine: #fff; }
    .f { mask-image: linear-gradient(#000, transparent); }
    @media (max-width: 52rem) { .g { padding: var(--sp-2); } }
  `);
  assert.deepEqual(found, []);
});

test("listed product CSS holds no raw values", () => {
  for (const file of TOKENS_ONLY) {
    const css = readFileSync(join(FRONTEND, file), "utf8");
    assert.deepEqual(rawValues(css), [], file);
  }
});

test("space.css defines the 2.0 layout tokens", () => {
  const space = source("space.css");
  for (const [token, value] of [
    ["--inspector-sm", "20rem"],
    ["--av-xs", "1.25rem"],
    ["--av-sm", "1.5rem"],
    ["--av-md", "2rem"],
    ["--av-lg", "3rem"],
    ["--dot", "0.4375rem"],
  ]) {
    assert.match(
      space,
      new RegExp(`${token}:\\s*${value.replace(".", "\\.")};`),
    );
  }
});

test("patterns.css follows decisions D4, D8, D16 and the M18 base border", () => {
  const patterns = source("patterns.css");
  for (const retired of [".pt-req-clock", ".pt-req-resolved", ".pt-stack"]) {
    assert.ok(!patterns.includes(retired), `${retired} is retired (D4)`);
  }
  assert.match(
    patterns,
    /\.pt-session\[aria-current="page"\] \{ background: var\(--signal-soft\); color: var\(--signal-ink\); \}/,
  );
  assert.match(patterns, /\.pt-brand-word \{[^}]*font-size: var\(--t-h3\);/);
  assert.match(
    patterns,
    /\.pt-composer \{[^}]*border: 1px solid var\(--line\);/,
  );
  assert.match(patterns, /\.pt-req \{[^}]*border-radius: var\(--r-lg\);/);
});

test("the spec's migration list no longer carries the rows this task did", () => {
  const list = source("DESIGN-SPEC.md").split("### 19.5")[1].split("## 20.")[0];
  for (const row of ["M4", "M6", "M14", "M15", "M18"]) {
    assert.ok(
      !new RegExp(`^\\| ${row} \\|`, "m").test(list),
      `${row} still listed`,
    );
  }
});

test("only the printed ID card, not the frame around it, skips the tokens check", () => {
  // agent-card.css is sanctioned artwork (19.1). The desk's stage, its note
  // and close button are product layout and belong in checked CSS.
  const art = readFileSync(
    join(FRONTEND, "styles/app/agent-card.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const frame = [...art.matchAll(/([^{}]*)\{[^{}]*\}/g)]
    .map((rule) => rule[1].trim())
    .filter((selector) => /\.idd-(stage|x)\b/.test(selector));
  assert.deepEqual(frame, []);
});

test("a heading resized in product CSS also takes its role's cut", () => {
  // type.css gives h1/h2 the narrow display cut; shrinking the size alone
  // leaves a condensed, tightly tracked heading smaller than the body (3.2).
  const files = [...TOKENS_ONLY, "styles/app/capabilities-board.css"];
  const loose: string[] = [];
  for (const file of files) {
    const css = readFileSync(join(FRONTEND, file), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const heads = selector
        .split(",")
        .some((part) => /(^|[\s>+~])h[1-4]([:[]|$)/.test(part.trim()));
      if (heads && /font-size\s*:/.test(body)) {
        const cut = /font-variation-settings\s*:/.test(body);
        const tracking = /letter-spacing\s*:/.test(body);
        if (!cut || !tracking) loose.push(`${file}: ${selector.trim()}`);
      }
    }
  }
  assert.deepEqual(loose, []);
});

test("a classed heading resized in product CSS also takes its role's cut", () => {
  // <h3 className="rq-title"> keeps h3's condensed cut and tight tracking
  // unless the class sets its own.
  const classes = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (path.endsWith(".tsx"))
        for (const [, list] of readFileSync(path, "utf8").matchAll(
          /<h[1-4][^>]*\bclassName="([^"]+)"/g,
        ))
          for (const c of list.split(/\s+/)) classes.add(c);
    }
  };
  walk(join(FRONTEND, "components"));
  const loose: string[] = [];
  for (const file of TOKENS_ONLY) {
    const css = readFileSync(join(FRONTEND, file), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const names = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      if (!names.some((n) => classes.has(n)) || !/font-size\s*:/.test(body))
        continue;
      const cut = /font-variation-settings\s*:/.test(body);
      const tracking = /letter-spacing\s*:/.test(body);
      if (!cut || !tracking) loose.push(`${file}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(loose, []);
});
