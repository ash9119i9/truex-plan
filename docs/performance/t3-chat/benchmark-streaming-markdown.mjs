// CPU-only actual ReactMarkdown/GFM parsing, transforms and server HTML rendering.
// node --experimental-strip-types benchmark-streaming-markdown.mjs --repo /path --mode full|incremental
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
const args = process.argv.slice(2);
const repo = resolve(args[args.indexOf("--repo") + 1]);
const mode = args[args.indexOf("--mode") + 1];
if (!["full", "incremental"].includes(mode))
  throw new Error("Expected --mode full|incremental");
const require = createRequire(resolve(repo, "frontend/package.json"));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { default: Markdown } = await import(
  pathToFileURL(require.resolve("react-markdown"))
);
const { default: remarkGfm } = await import(
  pathToFileURL(require.resolve("remark-gfm"))
);
const createPlugin =
  mode === "incremental"
    ? (
        await import(
          pathToFileURL(resolve(repo, "frontend/lib/markdown-incremental.ts"))
        )
      ).createIncrementalMarkdownPlugin
    : undefined;
const code = Array.from(
  { length: 320 },
  (_, i) => `const value${i} = ${i};`,
).join("\n");
const fixtures = {
  closed_code: `# Analysis\n\n${Array.from({ length: 3 }, () => "```ts\n" + code + "\n```\n\n").join("")}`,
  prose_control: Array.from(
    { length: 75 },
    (_, i) =>
      `Paragraph ${i}: **details** and [link](https://example.com).\n\n`,
  ).join(""),
};
function sample(base) {
  let parsedChars = 0,
    parseMs = 0,
    renderMs = 0;
  const observe = function () {
    const original = this.parser;
    this.parser = (source, file) => {
      parsedChars += source.length;
      const start = performance.now();
      const root = original(source, file);
      parseMs += performance.now() - start;
      return root;
    };
  };
  const activate = createPlugin && /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(base);
  const plugin = activate ? createPlugin() : undefined;
  const streamPlugins = [remarkGfm, observe, ...(plugin ? [plugin] : [])];
  const digest = createHash("sha256");
  let text = base;
  for (let i = 0; i <= 80; i++) {
    if (i) text += ` More streamed **detail ${i}**.`;
    // The final settled answer deliberately uses the full parse, as in the component.
    const plugins = i === 80 ? [remarkGfm, observe] : streamPlugins;
    const start = performance.now();
    const html = renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: plugins }, text),
    );
    renderMs += performance.now() - start;
    digest.update(html);
  }
  return { renderMs, parseMs, parsedChars, htmlSha256: digest.digest("hex") };
}
const results = {};
for (const [name, base] of Object.entries(fixtures)) {
  sample(base);
  const samples = Array.from({ length: 5 }, () => sample(base));
  const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[2];
  results[name] = {
    sourceChars: base.length,
    updates: 81,
    samples,
    medianRenderMs: median("renderMs"),
    medianParseMs: median("parseMs"),
  };
}
console.log(
  JSON.stringify(
    {
      repo,
      mode,
      node: process.version,
      cpu: cpus()[0].model,
      warmups: 1,
      sampleCount: 5,
      scope:
        "CPU-only ReactMarkdown+GFM parse/transform/server HTML serialization; final update full parse; no browser reconciliation/layout/network",
      results,
    },
    null,
    2,
  ),
);
