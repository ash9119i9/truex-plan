import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { patchSource, patchLegendList } from "../scripts/patch-legend-list.mjs";
const directory = resolve(
  import.meta.dirname,
  "../node_modules/@legendapp/list",
);
for (const filename of ["react.js", "react.mjs"]) {
  test(`${filename}: exact source patch is idempotent and rejects unknown modifications`, async () => {
    const source = await readFile(resolve(directory, filename), "utf8");
    const patched = patchSource(source, filename);
    assert.equal(patchSource(patched, filename), patched);
    assert.throws(
      () => patchSource(patched + "\n// unexpected edit", filename),
      /Unexpected LegendList/,
    );
    assert.throws(() =>
      patchSource(
        patched.replace(
          "value: contentNode.style[axis.paddingEndProp]",
          "value: temporaryPaddingEnd",
        ),
        filename,
      ),
    );
    assert.match(patched, /Copyright \(c\) 2026 T3 Tools Inc/);
  });
}
test("patched DOM reordering uses native moveBefore and supports both fallbacks", async () => {
  const source = patchSource(
    await readFile(resolve(directory, "react.mjs"), "utf8"),
    "react.mjs",
  );
  const start = source.indexOf("function moveChildBefore(");
  const end = source.indexOf("function sortDOMElements(", start);
  const move = vm.runInNewContext(
    source.slice(start, end) + "; moveChildBefore;",
  );
  const element = {},
    reference = {},
    calls: unknown[][] = [];
  move(
    { moveBefore: (...args: unknown[]) => calls.push(["move", ...args]) },
    element,
    reference,
  );
  move(
    { insertBefore: (...args: unknown[]) => calls.push(["insert", ...args]) },
    element,
    reference,
  );
  move(
    { appendChild: (...args: unknown[]) => calls.push(["append", ...args]) },
    element,
    null,
  );
  assert.deepEqual(calls, [
    ["move", element, reference],
    ["insert", element, reference],
    ["append", element],
  ]);
});
test("temporary padding records browser normalization for baseline restoration", async () => {
  const source = patchSource(
    await readFile(resolve(directory, "react.mjs"), "utf8"),
    "react.mjs",
  );
  const start = source.indexOf(
    "            contentNode.style[axis.paddingEndProp] = temporaryPaddingEnd;",
  );
  const end = source.indexOf(
    "            void contentNode.offsetHeight;",
    start,
  );
  let serialized = "40px";
  const style = Object.defineProperty({}, "paddingBottom", {
    get: () => serialized,
    set: (value: string) => {
      serialized = `${Number.parseFloat(value).toFixed(4)}px`;
    },
  });
  const state = {
    contentNode: { style },
    axis: { paddingEndProp: "paddingBottom" },
    temporaryPaddingEnd: "40.333333333333px",
    baselinePaddingEnd: "40px",
    temporaryPaddingRef: {
      current: undefined as { baseline: string; value: string } | undefined,
    },
  };
  vm.runInNewContext(source.slice(start, end), state);
  assert.equal(state.temporaryPaddingRef.current?.value, serialized);
  assert.notEqual(
    state.temporaryPaddingRef.current?.value,
    state.temporaryPaddingEnd,
  );
  if (serialized === state.temporaryPaddingRef.current?.value)
    serialized = state.temporaryPaddingRef.current!.baseline;
  assert.equal(serialized, "40px");
});
test("check never writes; mismatches are rejected before either bundle is written; apply is idempotent", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "legend-web-patch-"));
  try {
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({ name: "@legendapp/list", version: "3.3.5" }),
    );
    const sources = await Promise.all(
      ["react.js", "react.mjs"].map((filename) =>
        readFile(resolve(directory, filename), "utf8"),
      ),
    );
    await Promise.all(
      ["react.js", "react.mjs"].map((filename, index) =>
        writeFile(resolve(fixture, filename), sources[index]),
      ),
    );
    const requiresPatch = sources.some(
      (source, index) =>
        patchSource(source, ["react.js", "react.mjs"][index]) !== source,
    );
    if (requiresPatch)
      await assert.rejects(
        patchLegendList({ directory: fixture, check: true }),
        /fixes are missing/,
      );
    else
      assert.deepEqual(
        await patchLegendList({ directory: fixture, check: true }),
        { changed: 0 },
      );
    assert.equal(
      await readFile(resolve(fixture, "react.js"), "utf8"),
      sources[0],
    );
    await writeFile(
      resolve(fixture, "react.mjs"),
      sources[1] + "\n// corruption",
    );
    await assert.rejects(
      patchLegendList({ directory: fixture }),
      /Unexpected LegendList/,
    );
    assert.equal(
      await readFile(resolve(fixture, "react.js"), "utf8"),
      sources[0],
    );
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({ name: "@legendapp/list", version: "3.3.6" }),
    );
    await assert.rejects(
      patchLegendList({ directory: fixture }),
      /exact @legendapp\/list 3.3.5/,
    );
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({ name: "@legendapp/list", version: "3.3.5" }),
    );
    await writeFile(resolve(fixture, "react.mjs"), sources[1]);
    await patchLegendList({ directory: fixture });
    assert.deepEqual(
      await patchLegendList({ directory: fixture, check: true }),
      { changed: 0 },
    );
    assert.deepEqual(await patchLegendList({ directory: fixture }), {
      changed: 0,
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// Restore the exact installed npm fixture even after postinstall has patched it.
// patchSource's original SHA checks validate this fixture before any write.
function originalFixture(source: string) {
  return source
    .replace(
      /\/\*\n \* Truex web-only patch[\s\S]*?function sortDOMElements\(/,
      "function sortDOMElements(",
    )
    .replace(
      "moveChildBefore(container, element, nextStableElement);",
      "container.insertBefore(element, nextStableElement);",
    )
    .replace(
      "moveChildBefore(container, element, null);",
      "container.appendChild(element);",
    )
    .replace(
      "            contentNode.style[axis.paddingEndProp] = temporaryPaddingEnd;\n            temporaryPaddingRef.current = { baseline: baselinePaddingEnd, value: contentNode.style[axis.paddingEndProp] };",
      "            temporaryPaddingRef.current = { baseline: baselinePaddingEnd, value: temporaryPaddingEnd };\n            contentNode.style[axis.paddingEndProp] = temporaryPaddingEnd;",
    );
}

test("apply archives stale webpack cache once; check and idempotent apply preserve new cache", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "legend-webpack-fixture-"));
  const webpackCacheDirectory = resolve(fixture, ".next/cache/webpack");
  let archive: string | undefined;
  try {
    await mkdir(webpackCacheDirectory, { recursive: true });
    await writeFile(
      resolve(webpackCacheDirectory, "cached-bundle"),
      "before patch",
    );
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({ name: "@legendapp/list", version: "3.3.5" }),
    );
    for (const filename of ["react.js", "react.mjs"]) {
      const source = originalFixture(
        await readFile(resolve(directory, filename), "utf8"),
      );
      await writeFile(resolve(fixture, filename), source);
    }
    await assert.rejects(
      patchLegendList({
        directory: fixture,
        webpackCacheDirectory,
        check: true,
      }),
      /fixes are missing/,
    );
    assert.equal(
      await readFile(resolve(webpackCacheDirectory, "cached-bundle"), "utf8"),
      "before patch",
    );
    const result = await patchLegendList({
      directory: fixture,
      webpackCacheDirectory,
    });
    archive = result.cacheArchive;
    assert.equal(result.changed, 2);
    assert.ok(archive);
    assert.equal(
      await readFile(resolve(archive, "webpack/cached-bundle"), "utf8"),
      "before patch",
    );
    await assert.rejects(
      readFile(resolve(webpackCacheDirectory, "cached-bundle")),
      { code: "ENOENT" },
    );
    await mkdir(webpackCacheDirectory, { recursive: true });
    await writeFile(
      resolve(webpackCacheDirectory, "cached-bundle"),
      "after patch",
    );
    assert.deepEqual(
      await patchLegendList({ directory: fixture, webpackCacheDirectory }),
      { changed: 0 },
    );
    assert.deepEqual(
      await patchLegendList({
        directory: fixture,
        webpackCacheDirectory,
        check: true,
      }),
      { changed: 0 },
    );
    assert.equal(
      await readFile(resolve(webpackCacheDirectory, "cached-bundle"), "utf8"),
      "after patch",
    );
    // A fresh install has no webpack cache and must still patch successfully.
    await rm(webpackCacheDirectory, { recursive: true, force: true });
    for (const filename of ["react.js", "react.mjs"]) {
      await writeFile(
        resolve(fixture, filename),
        originalFixture(await readFile(resolve(directory, filename), "utf8")),
      );
    }
    assert.deepEqual(
      await patchLegendList({ directory: fixture, webpackCacheDirectory }),
      { changed: 2 },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
    if (archive) await rm(archive, { recursive: true, force: true });
  }
});
