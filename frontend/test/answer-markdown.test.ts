import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { StreamingMarkdown } = component("streaming-markdown.tsx");
const render = (text: string) =>
  renderToStaticMarkup(
    createElement(StreamingMarkdown, { text, streaming: false }),
  );

test("a code block carries its language and actions in a header bar inside the frame", () => {
  const html = render("```ts\nconst a = 1;\n```");
  const block = html.match(
    /<div class="code-block"[^>]*>([\s\S]*)<\/div>/,
  )?.[1];
  assert.ok(block, html);
  const bar = block.match(/<div class="code-bar">([\s\S]*?)<\/pre>/)?.[0] ?? "";
  assert.match(bar, /<span class="code-lang">ts<\/span>/);
  assert.ok(
    bar.indexOf("Wrap lines") < bar.indexOf("<pre"),
    "actions sit in the bar, above the code",
  );
});

test("a code block without a language labels itself as code", () => {
  assert.match(
    render("```\nplain\n```"),
    /<span class="code-lang">code<\/span>/,
  );
});

test("answer lists restore the markers the reset removes", () => {
  const css = readFileSync(
    new URL("../styles/app/turn.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.markdown ul\s*\{[^}]*list-style:\s*disc/);
  assert.match(css, /\.markdown ol\s*\{[^}]*list-style:\s*decimal/);
});
