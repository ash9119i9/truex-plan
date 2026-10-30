import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { StreamingMarkdown } = component("streaming-markdown.tsx");
const render = (Component: any, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(Component, props));

test("Markdown controls leave code bytes and safe Markdown handling intact", () => {
  const html = render(StreamingMarkdown, {
    text: "```txt\n  λ <tag> & value\n\n```\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>",
    streaming: false,
  });
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(
    html,
    /<code class="language-txt">  λ &lt;tag&gt; &amp; value\n\n<\/code>/,
  );
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes("<script>"));
});
