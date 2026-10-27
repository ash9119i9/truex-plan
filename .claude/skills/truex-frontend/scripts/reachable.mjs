// Lists the frontend source files a route actually loads, starting from every
// Next.js entry file under frontend/app. Files under components/, lib/ and
// legacy/ that no route reaches are old-stack code still in the tree.
//
//   node .claude/skills/truex-frontend/scripts/reachable.mjs              # reached files
//   node .claude/skills/truex-frontend/scripts/reachable.mjs --unreached  # unreached files
//   node .claude/skills/truex-frontend/scripts/reachable.mjs <file>...    # is each file reached?
//
// Run from the repository root. Follows static imports, `export … from`,
// side-effect imports and literal dynamic `import("…")`; "@/" resolves to
// frontend/. A computed import path is not followed.
import fs from "node:fs";
import path from "node:path";

const frontend = path.resolve("frontend");
if (!fs.existsSync(path.join(frontend, "app"))) {
  console.error("Run from the repository root (frontend/app not found).");
  process.exit(2);
}

const ENTRY =
  /^(page|layout|template|route|error|global-error|not-found|loading|default)\.(tsx?|jsx?)$/;
const SOURCE = /\.(tsx?|jsx?|mjs)$/;
const IMPORT =
  /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

function files(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : files(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

function resolve(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(frontend, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  const candidates = SUFFIXES.map((s) => base + s);
  // `./x.ts` imports may name a .tsx file.
  if (base.endsWith(".ts")) candidates.push(base + "x");
  return (
    candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null
  );
}

const reached = new Set();
function walk(file) {
  if (reached.has(file)) return;
  reached.add(file);
  if (!SOURCE.test(file)) return;
  for (const m of fs.readFileSync(file, "utf8").matchAll(IMPORT)) {
    const target = resolve(file, m[1] ?? m[2] ?? m[3]);
    if (target) walk(target);
  }
}
for (const entry of files(path.join(frontend, "app"), (n) => ENTRY.test(n)))
  walk(entry);

const rel = (p) => path.relative(process.cwd(), p);
const args = process.argv.slice(2);
if (args[0] === "--unreached") {
  const all = ["components", "lib", "legacy"].flatMap((d) =>
    files(path.join(frontend, d), (n) => SOURCE.test(n)),
  );
  for (const f of all.filter((f) => !reached.has(f)).sort())
    console.log(rel(f));
} else if (args.length) {
  let missing = 0;
  for (const arg of args) {
    const ok = reached.has(path.resolve(arg));
    if (!ok) missing++;
    console.log(`${ok ? "reached  " : "UNREACHED"} ${arg}`);
  }
  process.exit(missing ? 1 : 0);
} else {
  for (const f of [...reached].sort()) console.log(rel(f));
}
