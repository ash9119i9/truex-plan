import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  prepareVisualizationDocument,
  validateVisualizationDocument,
  visualizationThemeCss,
} from "../../shared/visualization-document.ts";
import { splitVisualizations, validWidgetState } from "../lib/visualization.ts";
import {
  visualizationDocument,
  visualizationExport,
} from "../lib/visualization-document.ts";
const id = "12345678-1234-1234-1234-123456789abc";
const reference = `[truex-visualization:${id}]`;
const visual = {
  id,
  title: "Sales",
  description: "Sales by region",
  mode: "inline" as const,
  html: '<div id="chart">Chart</div><script>document.getElementById("chart").textContent="Ready"</script>',
};

test("visual references render inline while prose and code remain intact", () => {
  assert.deepEqual(splitVisualizations(`Before\n\n${reference}\n\nAfter`), [
    { type: "markdown", text: "Before\n\n" },
    { type: "visualization", id },
    { type: "markdown", text: "\nAfter" },
  ]);
  for (const text of [
    `\`\`\`text\n${reference}\n\`\`\``,
    `Example ${reference}`,
    `    ${reference}`,
    "[truex-visualization:../../private]",
    "<script>alert(1)</script>",
  ]) {
    assert.deepEqual(splitVisualizations(text), [{ type: "markdown", text }]);
  }
  assert.deepEqual(
    splitVisualizations("Before\n[truex-visualization:1234", true),
    [{ type: "markdown", text: "Before\n" }],
  );
  assert.deepEqual(splitVisualizations(reference), [
    { type: "visualization", id },
  ]);
});
test("saved widget state is bounded and rejects invalid envelopes", () => {
  assert.ok(
    validWidgetState({
      modelContent: { rate: 4 },
      privateContent: { open: true },
    }),
  );
  for (const state of [
    null,
    [],
    "text",
    { extra: true },
    { modelContent: "a".repeat(16385) },
    { modelContent: "界".repeat(6000) },
  ])
    assert.equal(validWidgetState(state), false);
  const circular: any = {};
  circular.modelContent = circular;
  assert.equal(validWidgetState(circular), false);
});
test("visual wrapper confines scripts and prevents title and saved-state injection", () => {
  const doc = visualizationDocument(
    { ...visual, title: "</title><script>titleAttack()</script>" },
    {
      modelContent: "</script><script>stateAttack()</script>",
      privateContent: null,
    },
  );
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /frame-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.match(doc, /base-uri 'none'/);
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf(visual.html));
  assert.ok(!doc.includes("<script>titleAttack()"));
  assert.ok(!doc.includes("<script>stateAttack()"));
  assert.ok(doc.includes("\\u003c/script\\u003e"));
  assert.match(doc, /setWidgetState/);
  assert.match(doc, /sendFollowUpMessage/);
});
test("download preserves sandboxing instead of exporting an unrestricted document", () => {
  const html = visualizationExport(visual, null);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(
    html,
    /allow-same-origin|allow-top-navigation|allow-popups/,
  );
  assert.match(html, /frame-src 'self'/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes(visual.html));
});

const completeHtml = `<!doctype html><html lang="en"><head><style>#chart{color:var(--foreground)}</style><script>window.first=1</script></head><body class="chart-page"><div id="chart">Chart &amp; data</div><script>window.second=window.first+1</script></body></html>`;
function documentElements(html: string) {
  const document = parse(html);
  const elements: DefaultTreeAdapterMap["element"][] = [];
  const parents = [document as DefaultTreeAdapterMap["parentNode"]];
  while (parents.length) {
    const parent = parents.shift()!;
    for (const node of parent.childNodes) {
      if (!("tagName" in node)) continue;
      elements.push(node);
      parents.push(node);
    }
  }
  return elements;
}
test("complete documents are parsed with host policy first and source order preserved", () => {
  const source = completeHtml.replace(
    "<head>",
    `<head><BASE href="https://host.invalid"><meta HTTP-EQUIV="refresh" content="0;url=https://host.invalid"><meta http-equiv="Content-Security-Policy" content="default-src *"><title>Source title</title>`,
  );
  const html = prepareVisualizationDocument(
    { ...visual, html: source, sourceFormat: "document" },
    null,
    { appearance: "dark" },
  );
  const elements = documentElements(html);
  assert.equal(elements.filter((node) => node.tagName === "html").length, 1);
  assert.equal(elements.filter((node) => node.tagName === "head").length, 1);
  assert.equal(elements.filter((node) => node.tagName === "body").length, 1);
  assert.equal(elements.filter((node) => node.tagName === "base").length, 0);
  assert.equal(
    elements.filter(
      (node) =>
        node.tagName === "meta" &&
        node.attrs.some((attr) => attr.name === "http-equiv"),
    ).length,
    1,
  );
  assert.ok(
    html.indexOf("Content-Security-Policy") < html.indexOf("window.first"),
  );
  assert.ok(html.indexOf("setWidgetState") < html.indexOf("window.first"));
  assert.ok(html.indexOf("window.first") < html.indexOf("window.second"));
  assert.match(html, /lang="en"/);
  assert.match(html, /class="chart-page"/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /Chart &amp; data/);
});
test("document validation distinguishes real structure from code, comments and parser repair", () => {
  assert.equal(validateVisualizationDocument(completeHtml), true);
  assert.equal(
    validateVisualizationDocument(completeHtml.replace("<!doctype html>", "")),
    true,
  );
  for (const html of [
    "<div>Fragment</div>",
    "<!-- <html><head></head><body></body></html> --><div>Fragment</div>",
    `<script>const example='<html><head></head><body></body></html>'</script>`,
    "<html><head></head><body>Unclosed",
    "<html><head></head><frameset></frameset></html>",
    "<template><html><head></head><body></body></html></template>",
  ])
    assert.equal(validateVisualizationDocument(html), false, html);
});
test("live theme updates validate the parent and preserve bridge selections", async () => {
  const saved = {
    modelContent: { teamSize: 7 },
    privateContent: { expanded: true },
  };
  const html = prepareVisualizationDocument(visual, saved, {
    appearance: "light",
  });
  assert.match(html, /--bg: #FFFFFF/);
  assert.match(html, /--bg: #171717/);
  assert.match(html, /--background:var\(--bg\)/);
  assert.doesNotMatch(html, /#faf9f6|#34492b/);
  const bootstrap = documentElements(html).find(
    (node) => node.tagName === "script",
  )!;
  const code = bootstrap.childNodes
    .map((node) => ("value" in node ? node.value : ""))
    .join("");
  const listeners = new Map<string, (event: any) => void>();
  const messages: any[] = [];
  const parent = { postMessage: (message: any) => messages.push(message) };
  const window: any = {};
  const root = { dataset: { theme: "light" }, style: { colorScheme: "light" } };
  runInNewContext(code, {
    window,
    parent,
    TextEncoder,
    document: { documentElement: root },
    addEventListener: (type: string, listener: (event: any) => void) =>
      listeners.set(type, listener),
    dispatchEvent: () => {},
    CustomEvent: class {
      constructor(..._args: any[]) {}
    },
  });
  const before = window.openai.widgetState;
  listeners.get("message")!({
    source: {},
    data: { channel: "truex-visualization", type: "theme", appearance: "dark" },
  });
  assert.equal(root.dataset.theme, "light");
  listeners.get("message")!({
    source: parent,
    data: {
      channel: "truex-visualization",
      type: "theme",
      appearance: "invalid",
    },
  });
  assert.equal(root.dataset.theme, "light");
  listeners.get("message")!({
    source: parent,
    data: { channel: "truex-visualization", type: "theme", appearance: "dark" },
  });
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(window.openai.widgetState, before);
  assert.equal(messages.length, 0);
  await window.openai.setWidgetState({
    modelContent: { teamSize: 9 },
    privateContent: null,
  });
  assert.equal(window.openai.widgetState.modelContent.teamSize, 9);
  assert.equal(messages[0].type, "state");
});
test("a typed publication suppresses only its standalone marker, retaining surrounding prose", () => {
  assert.deepEqual(
    splitVisualizations(`Before\n${reference}\nAfter`, false, [id]),
    [
      { type: "markdown", text: "Before\n" },
      { type: "markdown", text: "After" },
    ],
  );
  assert.deepEqual(splitVisualizations(reference, false, []), [
    { type: "visualization", id },
  ]);
  const example = `\`\`\`html\n${reference}\n\`\`\``;
  assert.deepEqual(splitVisualizations(example, false, [id]), [
    { type: "markdown", text: example },
  ]);
});
test("exports use the same prepared complete document and capture the current theme/state", () => {
  const source = {
    ...visual,
    html: completeHtml,
    sourceFormat: "document" as const,
  };
  const state = { modelContent: { rate: 5 }, privateContent: null };
  const exported = visualizationExport(source, state, "dark");
  const frame = documentElements(exported).find(
    (node) => node.tagName === "iframe",
  )!;
  const srcdoc = frame.attrs.find((attr) => attr.name === "srcdoc")!.value;
  assert.equal(
    srcdoc,
    prepareVisualizationDocument(source, state, {
      appearance: "dark",
      standalone: true,
    }),
  );
  assert.match(srcdoc, /data-theme="dark"/);
  assert.match(srcdoc, /"rate":5/);
});

test("deep generated markup is rejected before recursive serialization", () => {
  const html = `<html><head></head><body>${"<div>".repeat(150)}data${"</div>".repeat(150)}</body></html>`;
  assert.equal(validateVisualizationDocument(html), false);
  assert.throws(
    () =>
      prepareVisualizationDocument(
        { ...visual, html, sourceFormat: "document" },
        null,
      ),
    /maximum nesting/,
  );
});

test("shared visual theme matches the authoritative Truex common and forced-dark tokens", () => {
  const spec = readFileSync(
    new URL("../styles/v2/tokens.css", import.meta.url),
    "utf8",
  );
  function declarations(css: string, selector: RegExp) {
    const values = new Map<string, string>();
    for (const block of css.matchAll(selector))
      for (const declaration of block[1].matchAll(
        /((?:--[\w-]+)|color-scheme)\s*:\s*([^;]+);/g,
      ))
        values.set(declaration[1], declaration[2].trim());
    return values;
  }
  for (const selector of [
    /^\s*:root\s*\{([^}]+)\}/gm,
    /^\s*:root\[data-theme="dark"\]\s*\{([^}]+)\}/gm,
  ]) {
    const expected = declarations(spec, selector);
    const actual = declarations(visualizationThemeCss, selector);
    assert.ok(expected.size >= 10, "The authoritative palette must be present");
    for (const [token, value] of expected)
      assert.equal(actual.get(token), value, `Theme token drift: ${token}`);
  }
});
