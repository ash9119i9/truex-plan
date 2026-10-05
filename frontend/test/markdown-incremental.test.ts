import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";
import type { Plugin } from "unified";
import { createIncrementalMarkdownPlugin } from "../lib/markdown-incremental.ts";

function renderer(incremental = false) {
  const sources: string[] = [];
  let tree: Root | undefined;
  const observe: Plugin<[], Root> = function () {
    const parse = this.parser!;
    this.parser = (source, file) => {
      sources.push(source);
      return parse(source, file);
    };
    return (root) => {
      tree = structuredClone(root);
    };
  };
  const plugins = [
    remarkGfm,
    observe,
    ...(incremental ? [createIncrementalMarkdownPlugin()] : []),
  ];
  return {
    sources,
    render(source: string) {
      const html = renderToStaticMarkup(
        createElement(Markdown, { remarkPlugins: plugins }, source),
      );
      return { html, tree };
    },
  };
}
const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";
for (const [name, suffix] of Object.entries({
  prose: "Hello **world**\n\nHeading\n=======\n\n- first\n- second\n",
  gfm: "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~ https://example.com\n",
  references: "[later][ref]\n\n[ref]: https://example.com\n",
  footnotes: "note[^a]\n\n[^a]: A footnote\n",
  nested: "> quote\n> ```js\n> x\n> ```\n\n- item\n\n    indented\n",
  unclosed: "~~~~js\nstreaming\n~~~\nmore\n",
  html: "<script>alert('unsafe')</script>\n\nUnicode नमस्ते 😀\n",
})) {
  test(`incremental matches full HTML and positions at every streamed prefix: ${name}`, () => {
    const full = renderer();
    const incremental = renderer(true);
    const source = prefix + suffix;
    for (let end = 0; end <= source.length; end++) {
      assert.deepEqual(
        incremental.render(source.slice(0, end)),
        full.render(source.slice(0, end)),
        `prefix ${end}`,
      );
    }
  });
}
test("only the suffix is parsed after a completed top-level fence", () => {
  const stream = renderer(true);
  stream.render(prefix);
  stream.sources.length = 0;
  stream.render(prefix + "next paragraph");
  assert.deepEqual(stream.sources, ["next paragraph"]);
});
test("prefix replacements, CRLF, BOM, and repeated transforms remain equivalent", () => {
  const full = renderer();
  const stream = renderer(true);
  for (const source of [
    prefix,
    prefix + "tail",
    prefix + "tail",
    prefix.replace("Before", "Edited") + "tail",
    prefix + "\r",
    prefix + "\r\nend",
    prefix + "\uFEFFinside",
    "new document",
  ]) {
    assert.deepEqual(stream.render(source), full.render(source));
  }
});
test("document definitions cannot freeze earlier reference resolution", () => {
  const stream = renderer(true);
  const before = "[link][target]\n\n" + prefix;
  stream.render(before);
  stream.sources.length = 0;
  const final = before + "[target]: https://example.com\n";
  assert.deepEqual(stream.render(final), renderer().render(final));
  assert.equal(stream.sources.at(-1), final);
});
test("caches remain private to each renderer", () => {
  const a = renderer(true);
  const b = renderer(true);
  a.render(prefix);
  b.render(prefix.replace("Before", "Other"));
  assert.deepEqual(a.render(prefix + "A"), renderer().render(prefix + "A"));
  assert.deepEqual(
    b.render(prefix.replace("Before", "Other") + "B"),
    renderer().render(prefix.replace("Before", "Other") + "B"),
  );
});
test("secondary transform parses use the original parser without altering the document cache", () => {
  const sources: string[] = [];
  const observe: Plugin<[], Root> = function () {
    const original = this.parser!;
    this.parser = (source, file) => {
      sources.push(source);
      return original(source, file);
    };
    return () => {
      this.parse("synthetic\n\n```\nexample\n```\n\n");
    };
  };
  const plugins = [remarkGfm, observe, createIncrementalMarkdownPlugin()];
  const render = (text: string) =>
    renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: plugins }, text),
    );
  render(prefix);
  sources.length = 0;
  render(prefix + "tail");
  assert.deepEqual(sources, ["tail", "synthetic\n\n```\nexample\n```\n\n"]);
});
