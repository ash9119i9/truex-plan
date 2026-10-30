#!/usr/bin/env node
// Bytes each route ships on first load: JavaScript from `next build`'s route stats, CSS and HTML
// from the prerendered pages. Raw, gzip (level 6, what `next start` sends) and brotli (quality 11,
// the best a precompressing proxy can send). Run from the repository root after `next build`.
//
//   node .claude/skills/truex-frontend-performance/scripts/route-weight.mjs
//   node .claude/skills/truex-frontend-performance/scripts/route-weight.mjs --save /tmp/truex-weight-base.json
//   node .claude/skills/truex-frontend-performance/scripts/route-weight.mjs --compare /tmp/truex-weight-base.json [--max-growth 1]
//
// --compare exits 1 when any route's JS or CSS (gzip) grew by more than --max-growth percent.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const dir = option("--dir") ?? "frontend";
const savePath = option("--save");
const comparePath = option("--compare");
const maxGrowth = Number(option("--max-growth") ?? 1);
if (!Number.isFinite(maxGrowth) || maxGrowth < 0) fail("--max-growth must be a percentage >= 0");

const statsPath = join(dir, ".next/diagnostics/route-bundle-stats.json");
if (!existsSync(statsPath)) fail(`${statsPath} not found: run \`npm --prefix ${dir} run build\` first`);

const sizes = new Map();
function weigh(file) {
  let size = sizes.get(file);
  if (!size) {
    const buf = readFileSync(join(dir, file));
    size = {
      raw: buf.length,
      gzip: gzipSync(buf, { level: 6 }).length,
      br: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    };
    sizes.set(file, size);
  }
  return size;
}
// Each file is compressed on its own, as it is sent.
const total = (files) =>
  files.reduce(
    (t, f) => {
      const s = weigh(f);
      return { raw: t.raw + s.raw, gzip: t.gzip + s.gzip, br: t.br + s.br };
    },
    { raw: 0, gzip: 0, br: 0 },
  );

// A prerendered page's HTML names the stylesheets it loads. Dynamic routes have no HTML at build
// time, so their CSS is reported as unknown rather than guessed.
function page(route) {
  if (route.includes("[")) return null;
  const html = join(".next/server/app", route === "/" ? "index.html" : `${route}.html`);
  if (!existsSync(join(dir, html))) return null;
  const text = readFileSync(join(dir, html), "utf8");
  const css = [...new Set([...text.matchAll(/href="\/_next\/(static\/[^"]+\.css)"/g)].map((m) => join(".next", m[1])))];
  return { html: weigh(html), css: total(css) };
}

const stats = JSON.parse(readFileSync(statsPath, "utf8"));
const routes = {};
for (const { route, firstLoadChunkPaths } of stats) {
  const p = page(route);
  routes[route] = { js: total(firstLoadChunkPaths), css: p?.css ?? null, html: p?.html ?? null };
}
const cssFiles = readdirSync(join(dir, ".next/static"), { recursive: true })
  .filter((f) => f.endsWith(".css"))
  .map((f) => join(".next/static", f));
const current = {
  builtAt: statSync(statsPath).mtime.toISOString(),
  routes,
  allCss: { files: cssFiles.length, ...total(cssFiles) },
};

const n = (v) => (v == null ? "-" : v.toLocaleString("en-US"));
const width = Math.max(...Object.keys(routes).map((r) => r.length));
console.log(`build ${current.builtAt}  (bytes; gzip level 6, brotli quality 11)`);
console.log(`${"route".padEnd(width)}  ${"JS raw".padStart(10)} ${"JS gzip".padStart(9)} ${"JS br".padStart(9)} ${"CSS gzip".padStart(9)} ${"HTML gzip".padStart(9)}`);
for (const [route, r] of Object.entries(routes)) {
  console.log(
    `${route.padEnd(width)}  ${n(r.js.raw).padStart(10)} ${n(r.js.gzip).padStart(9)} ${n(r.js.br).padStart(9)} ${n(r.css?.gzip).padStart(9)} ${n(r.html?.gzip).padStart(9)}`,
  );
}
console.log(`all CSS: ${current.allCss.files} files, ${n(current.allCss.raw)} raw, ${n(current.allCss.gzip)} gzip, ${n(current.allCss.br)} br`);

if (savePath) {
  writeFileSync(savePath, JSON.stringify(current, null, 2) + "\n");
  console.log(`saved ${savePath}`);
}

if (comparePath) {
  const base = JSON.parse(readFileSync(comparePath, "utf8"));
  const over = [];
  console.log(`\ncompared with build ${base.builtAt} (gzip)`);
  for (const route of new Set([...Object.keys(base.routes), ...Object.keys(routes)])) {
    const before = base.routes[route];
    const after = routes[route];
    if (!before || !after) {
      console.log(`${route.padEnd(width)}  ${before ? "removed" : "new route"}`);
      continue;
    }
    const parts = [];
    for (const kind of ["js", "css"]) {
      const b = before[kind]?.gzip;
      const a = after[kind]?.gzip;
      if (b == null || a == null) continue;
      const pct = b === 0 ? 0 : ((a - b) / b) * 100;
      parts.push(`${kind.toUpperCase()} ${n(b)} → ${n(a)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);
      if (pct > maxGrowth) over.push(`${route} ${kind.toUpperCase()} +${pct.toFixed(2)}%`);
    }
    console.log(`${route.padEnd(width)}  ${parts.join("   ")}`);
  }
  if (over.length) {
    console.log(`\nover the ${maxGrowth}% growth budget:\n  ${over.join("\n  ")}`);
    process.exitCode = 1;
  } else console.log(`\nwithin the ${maxGrowth}% growth budget`);
}

function fail(message) {
  console.error(`route-weight: ${message}`);
  process.exit(2);
}
