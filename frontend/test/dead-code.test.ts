import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

// Resolves "@/x" and relative specifiers the way tsconfig paths do.
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(FRONTEND, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const file = base + ext;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function reachableFromRoutes(): Set<string> {
  const seen = new Set<string>();
  const stack = walk(join(FRONTEND, "app")).filter((f) => /\.tsx?$/.test(f));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g,
    )) {
      const target = resolveImport(file, m[1]);
      if (target) stack.push(target);
    }
  }
  return seen;
}

// Known unreachable components, each with the task that resolves it. Shrinks to empty.
const KNOWN_UNREACHED: Record<string, string> = {
  "components/invite/join-page.tsx":
    "invitations redirect to sign-in in platform-next; Task 31",
};

test("legacy/ and the CSS only it used are gone", () => {
  assert.equal(existsSync(join(FRONTEND, "legacy")), false, "legacy/ remains");
  for (const file of [
    "app/shell.css",
    "app/chat.css",
    "app/panels.css",
    "app/observability.css",
    "app/responsive.css",
    "styles/v2/dock.css",
    "styles/v2/timeline.css",
    "styles/v2/agents-view.css",
  ]) {
    assert.equal(existsSync(join(FRONTEND, file)), false, `${file} remains`);
  }
});

test("every component is reachable from a route", () => {
  const live = reachableFromRoutes();
  const dead = walk(join(FRONTEND, "components"))
    .filter((f) => /\.tsx?$/.test(f) && !live.has(f))
    .map((f) => relative(FRONTEND, f))
    .filter((f) => !(f in KNOWN_UNREACHED))
    // The tx primitive library is adopted screen by screen (plan Tasks 12–33).
    .filter((f) => !f.startsWith("components/tx/"))
    .sort();
  assert.deepEqual(dead, []);
});
