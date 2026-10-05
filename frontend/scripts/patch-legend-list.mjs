/** Web-only fixes copied from T3 Code's @legendapp/list@3.3.5.patch.
 * https://github.com/pingdotgg/t3code/blob/main/patches/%40legendapp__list%403.3.5.patch
 * Run after npm install, or use --check to verify without modifying files.
 * No native, keyboard, reanimated, or anchored-end-space changes are applied.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const originals = {
  "react.js":
    "cd24ddf5b94add86030d3eb644330eb888579310b463178d025138d97a292d11",
  "react.mjs":
    "044202a4f9b52f055da7bb49635560c76d6bdb3a284a1125ce2e02fba8ba6cb9",
};
const notice = `/*
 * Truex web-only patch from T3 Code (LegendList 3.3.5).
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
`;
const helper =
  notice +
  `// Element.moveBefore preserves connected iframe and animation state.
function moveChildBefore(container, element, reference) {
  if (typeof container.moveBefore === "function") {
    container.moveBefore(element, reference);
  } else if (reference) {
    container.insertBefore(element, reference);
  } else {
    container.appendChild(element);
  }
}
`;
const anchor = "function sortDOMElements(container, indexByElement) {";
const oldPadding = `            temporaryPaddingRef.current = { baseline: baselinePaddingEnd, value: temporaryPaddingEnd };
            contentNode.style[axis.paddingEndProp] = temporaryPaddingEnd;`;
const newPadding = `            contentNode.style[axis.paddingEndProp] = temporaryPaddingEnd;
            temporaryPaddingRef.current = { baseline: baselinePaddingEnd, value: contentNode.style[axis.paddingEndProp] };`;
const replacements = [
  [anchor, helper + anchor],
  [
    "container.insertBefore(element, nextStableElement);",
    "moveChildBefore(container, element, nextStableElement);",
  ],
  [
    "container.appendChild(element);\n      }",
    "moveChildBefore(container, element, null);\n      }",
  ],
  [oldPadding, newPadding],
];
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2)
    throw new Error("LegendList patch source did not match exactly once");
  return source.replace(from, to);
}

export function patchSource(source, filename) {
  if (!Object.hasOwn(originals, filename))
    throw new Error("Unexpected LegendList web bundle");
  const patched = source.includes(notice);
  let original = source;
  if (patched) {
    // Recognize only our exact patch, including its attribution; no partial or
    // unknown dependency modifications are silently accepted.
    for (const [from, to] of [...replacements].reverse())
      original = replaceOnce(original, to, from);
  }
  const hash = createHash("sha256").update(original).digest("hex");
  if (hash !== originals[filename])
    throw new Error(`Unexpected LegendList 3.3.5 source: ${filename}`);
  if (patched) return source;
  for (const [from, to] of replacements) source = replaceOnce(source, from, to);
  return source;
}

/** @param {{directory: string, check?: boolean, webpackCacheDirectory?: string}} options */
export async function patchLegendList({
  directory,
  check = false,
  webpackCacheDirectory,
}) {
  const metadata = JSON.parse(
    await readFile(resolve(directory, "package.json"), "utf8"),
  );
  if (metadata.name !== "@legendapp/list" || metadata.version !== "3.3.5") {
    throw new Error(
      "LegendList web patch requires exact @legendapp/list 3.3.5; review before upgrading",
    );
  }
  // Validate both files before writing either; a mismatch must not partially patch.
  const bundles = await Promise.all(
    Object.keys(originals).map(async (filename) => {
      const path = resolve(directory, filename);
      const source = await readFile(path, "utf8");
      return { path, source, patched: patchSource(source, filename) };
    }),
  );
  const changed = bundles.filter((bundle) => bundle.source !== bundle.patched);
  if (check && changed.length)
    throw new Error(
      "LegendList web fixes are missing; run node scripts/patch-legend-list.mjs",
    );
  let cacheArchive;
  if (!check && changed.length && webpackCacheDirectory) {
    // Next webpack can reuse pre-patch dependency modules despite updated mtimes.
    // Archive its generated cache before touching bundles so a failed rename
    // cannot leave a successful patch paired with stale compiled JavaScript.
    const archive = await mkdtemp(
      resolve(tmpdir(), "truex-legend-webpack-cache-"),
    );
    try {
      await rename(webpackCacheDirectory, resolve(archive, "webpack"));
      cacheArchive = archive;
      console.log(`Archived pre-patch webpack cache: ${archive}`);
    } catch (error) {
      await rm(archive, { recursive: true, force: true });
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!check)
    for (const bundle of changed) await writeFile(bundle.path, bundle.patched);
  return { changed: changed.length, ...(cacheArchive ? { cacheArchive } : {}) };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some((flag) => flag !== "--check"))
      throw new Error("Usage: patch-legend-list.mjs [--check]");
    const directory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../node_modules/@legendapp/list",
    );
    const result = await patchLegendList({
      directory,
      check: flags.includes("--check"),
      webpackCacheDirectory: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../.next/cache/webpack",
      ),
    });
    console.log(
      `LegendList web fixes verified${result.changed ? ` (${result.changed} bundles patched)` : ""}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
