import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory()
      ? files(path, ext)
      : ext.test(name)
        ? [path]
        : [];
  });

// Classes of the retired v2 layer (styles/v2/base.css) and app/*.css.
const OLD =
  /className=[{"`][^}\n]*(?<![\w-])(btn-solid|btn-soft|btn-danger|btn-ghost|text-btn|icon-btn|spinner|sr-only|field-hint|field-label|button|button-primary|eyebrow)(?![\w-])/;

test("Task 32/33: no component or page uses a retired control class", () => {
  const offenders = [
    ...files("components", /\.tsx$/),
    ...files("app", /\.tsx$/),
  ].filter((file) => OLD.test(read(file)));
  assert.deepEqual(offenders, []);
});

test("Task 32: the connectors and viewer stylesheets moved onto tokens-only CSS", () => {
  assert.equal(existsSync(join(root, "styles/v2/connectors.css")), false);
  assert.equal(existsSync(join(root, "styles/v2/chat-files.css")), false);
  const list = read("test/design-system.test.ts");
  assert.match(list, /"styles\/app\/tools\.css"/);
  assert.match(list, /"styles\/app\/viewer\.css"/);
});

test("Task 33: error pages use the system's state card and button", () => {
  const { default: NotFound } = component("../app/not-found.tsx");
  const { default: ErrorPage } = component("../app/error.tsx");
  const notFound = renderToStaticMarkup(createElement(NotFound));
  assert.match(notFound, /class="tx-card tx-state app-error-card"/);
  assert.match(
    notFound,
    /<a class="tx-btn tx-primary" href="\/">Go to the workspace<\/a>/,
  );
  const error = renderToStaticMarkup(
    createElement(ErrorPage, {
      error: Object.assign(new Error("x"), { digest: "d1" }),
      reset() {},
    }),
  );
  assert.match(error, /role="alert"/);
  assert.match(error, /class="tx-btn tx-primary"[^>]*>Try again</);
  assert.match(error, /Reference: d1/);
});

test("Task 33: the last-resort error page still reads and works with no app CSS", () => {
  const { default: GlobalError } = component("../app/global-error.tsx");
  const html = renderToStaticMarkup(
    createElement(GlobalError, { error: new Error("x"), reset() {} }),
  );
  // inline styles carry the layout if the stylesheet never arrives
  assert.match(html, /<main class="app-error" style="[^"]*display:grid/);
  assert.match(html, /<button type="button"[^>]*>Try again<\/button>/);
});

test("Task 34: styles/v2 is gone and every product stylesheet is tokens only", () => {
  assert.equal(existsSync(join(root, "styles/v2")), false);
  const list = read("test/design-system.test.ts");
  // printed artwork, sanctioned by 19.1, is the only CSS off the list
  const ARTWORK = [
    "styles/app/agent-card.css",
    "styles/app/capabilities-board.css",
  ];
  for (const file of files("styles/app", /\.css$/))
    if (!ARTWORK.includes(file))
      assert.match(
        list,
        new RegExp(`"${file.replace(/[./]/g, "\\$&")}"`),
        file,
      );
  const globals = read("app/globals.css");
  assert.doesNotMatch(globals, /styles\/v2|--accent/);
});

test("Task 34: no old token name is left in product CSS or components", () => {
  const OLD_TOKENS =
    /var\(--(accent|bg|surface-3|border-control|font-(sans|mono|display|accent)|shadow-(sm|md|lg)|error-(bg|text)|info-(bg|text)|success-(bg|text)|warning-(bg|text)|muted|foreground|fg-2|radius(-sm|-md|-lg)?|tone-[0-9a-z-]+)\b/;
  const hits = [
    ...files("styles/app", /\.css$/),
    ...files("components", /\.tsx$/),
    "app/globals.css",
  ].filter((file) => OLD_TOKENS.test(read(file)));
  assert.deepEqual(
    hits.map((f) => relative(root, join(root, f))),
    [],
  );
});

test("Task 34: package.json lists no dependency nothing imports", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const gone of [
    "@legendapp/list",
    "@number-flow/react",
    "class-variance-authority",
    "lucide-react",
    "@radix-ui/react-select",
  ])
    assert.equal(pkg.dependencies[gone], undefined, gone);
  assert.equal(pkg.scripts.postinstall, undefined);
});
