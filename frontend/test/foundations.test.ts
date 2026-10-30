import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_FILES } from "./support/design-system.ts";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(FRONTEND, file), "utf8");
const walkSources = (dir: string): string[] =>
  readdirSync(join(FRONTEND, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(FRONTEND, path)).isDirectory()) return walkSources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
const imports = (css: string) =>
  [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);

test("globals.css loads the foundations and layers first, in spec 2.1 order", () => {
  const order = imports(read("app/globals.css"));
  const system = SYSTEM_FILES.map((f) => `../styles/system/${f}`);
  assert.deepEqual(order.slice(0, system.length), system);
  assert.ok(
    order.indexOf("../styles/app/reset.css") === system.length,
    "the reset follows the system layers",
  );
});

test("the root layout loads only the three system families", () => {
  const layout = read("app/layout.tsx");
  const href = layout.match(/fonts\.googleapis\.com\/css2\?[^"]+/)?.[0] ?? "";
  const families = [...href.matchAll(/family=([^:&]+)/g)].map((m) => m[1]);
  assert.deepEqual(families, [
    "Bricolage+Grotesque",
    "Instrument+Serif",
    "Geist+Mono",
  ]);
  assert.match(href, /opsz,wdth,wght@12\.\.96,75\.\.100,300\.\.800/);
  assert.match(href, /display=swap/);
});

test("the old v2 alias layer is gone (Tasks 3–34)", () => {
  // Task 3 aliased the old token names to system tokens so unported screens
  // kept working; Task 34 removed them once every screen was ported.
  assert.equal(
    existsSync(new URL("../styles/v2/tokens.css", import.meta.url)),
    false,
  );
});

test("Tailwind is gone: no package, import, PostCSS plugin or shadcn config", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of [
    "tailwindcss",
    "@tailwindcss/postcss",
    "tailwind-merge",
    "class-variance-authority",
  ]) {
    assert.equal(name in deps, false, `${name} is still a dependency`);
  }
  const lock = read("package-lock.json");
  assert.doesNotMatch(
    lock,
    /"node_modules\/(tailwindcss|@tailwindcss\/postcss|tailwind-merge)"/,
  );
  assert.doesNotMatch(read("app/globals.css"), /tailwindcss/);
  for (const file of [
    "postcss.config.mjs",
    "components.json",
    "lib/utils.ts",
  ]) {
    assert.equal(existsSync(join(FRONTEND, file)), false, `${file} remains`);
  }
});

// Tailwind utilities that would silently do nothing once Tailwind is gone.
const UTILITY =
  /^(?:(?:sm|md|lg|xl|hover|focus|dark):)*(?:-?(?:m|p)[trblxy]?-\d|flex-(?:row|col|1)|items-(?:center|start|end)|justify-(?:between|center|end)|gap-\d|text-(?:xs|sm|base|lg|xl|\[)|font-(?:medium|semibold|bold)|rounded(?:-|$)|bg-[a-z]+-\d|w-(?:full|\d|\[)|h-(?:full|\d|\[)|min-w-0|truncate$|shrink-0|inline-flex$|space-[xy]-)/;

test("no Tailwind utility classes remain in components or app", () => {
  const files = [...walkSources("components"), ...walkSources("app")];
  const found: string[] = [];
  for (const file of files) {
    for (const m of read(file).matchAll(
      /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
    )) {
      for (const cls of (m[1] ?? m[2]).split(/\s+/)) {
        if (UTILITY.test(cls)) found.push(`${file}: ${cls}`);
      }
    }
  }
  assert.deepEqual(found, []);
});
