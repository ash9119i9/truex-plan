import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools, ConversationFiles } from "../src/file-tools";
import {
  ChromiumPageRenderer,
  rendererTempRoot,
  scrubbedChromiumEnv,
  truncateConsole,
  type PageRenderer,
} from "../src/page-renderer";
import {
  visualizationDocument,
  visualizationExport,
} from "../../shared/visualization-document";
import { BusinessRuntime } from "../src/business-runtime";
import { visualizationInstructions } from "../../shared/visualizations";

const visual = {
  id: "12345678-1234-1234-1234-123456789abc",
  title: "Sales",
  description: "Sales by region",
  mode: "inline" as const,
  html: '<div id="chart">Chart</div><script>document.getElementById("chart").textContent="Ready"</script>',
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("shared document and export match the original frontend wrapper", () => {
  assert.equal(
    hash(visualizationDocument(visual, null)),
    "dcd9b25eb8b92811b61acf49c48dfcec0cb3590c7eac002c69137f101a3e536a",
  );
  const escaped = {
    ...visual,
    title: "</title><script>titleAttack()</script>",
  };
  const state = {
    modelContent: "</script><script>stateAttack()</script>",
    privateContent: { unit: "₹", line: "\u2028" },
  };
  assert.equal(
    hash(visualizationDocument(escaped, state)),
    "17a406df243807560781eed262c0500c662332e8560ed7f28bee405d8cf4ac7a",
  );
  assert.equal(
    hash(visualizationExport(escaped, state)),
    "61549f6cd033018a40c1653942c515f5f9065e1e55db0fe81406cd57bdd540ff",
  );
});

test("a visual follows the host's theme, light by default, and only accepts known values", () => {
  const scheme = (doc: string) => /:root \{ color-scheme:(\w+);/.exec(doc)?.[1];
  assert.equal(scheme(visualizationDocument(visual, null)), "light");
  assert.equal(
    scheme(visualizationDocument(visual, null, false, "dark")),
    "dark",
  );
  // Anything but "dark" is light, so a caller's string never reaches the CSS.
  assert.equal(
    scheme(
      visualizationDocument(
        visual,
        null,
        false,
        "red; } body { display:none" as any,
      ),
    ),
    "light",
  );
  const doc = visualizationDocument(visual, null);
  // The host can change the theme of a live frame; only its parent may.
  assert.match(doc, /type === "theme"/);
  assert.match(doc, /event\.source === parent/);
  assert.match(
    doc,
    /data\.appearance === "light" \|\| data\.appearance === "dark"/,
  );
});

test("the design kit gives a visual real building blocks, themed for both modes", () => {
  const doc = visualizationDocument(visual, null);
  for (const name of [
    ".viz-title",
    ".viz-chip",
    ".viz-card",
    ".viz-kpi",
    ".viz-kpi-label",
    ".viz-kpi-value",
    ".viz-kpi-delta",
    ".viz-up",
    ".viz-down",
    ".viz-legend",
    ".viz-swatch",
    ".viz-split",
    ".viz-tooltip",
  ])
    assert.ok(doc.includes(name + " {") || doc.includes(name + ","), name);
  // Colours come from tokens that switch with the theme.
  for (const token of [
    "--surface:",
    "--surface-2:",
    "--positive:",
    "--negative:",
  ])
    assert.ok(doc.includes(token + "light-dark("), token);
  // Motion is gentle and switched off for people who ask for less of it.
  assert.match(doc, /@keyframes viz-in/);
  assert.match(doc, /prefers-reduced-motion:reduce/);
  // A legend swatch takes its colour from a variable the page sets.
  assert.match(doc, /\.viz-swatch \{[^}]*background:var\(--c,currentColor\)/);
});

test("numbers are never broken in the middle, and long words still wrap", () => {
  const doc = visualizationDocument(visual, null);
  // `anywhere` let a value like $152.9k split into "$152.9" and "k".
  assert.ok(doc.includes("overflow-wrap:break-word"));
  assert.equal(doc.includes("overflow-wrap:anywhere"), false);
  assert.match(doc, /\.viz-kpi-value \{ white-space:nowrap;/);
});

test("the model is told how to build something polished, and not to narrate its checks", () => {
  const text = visualizationInstructions(true);
  for (const phrase of [
    ".viz-kpi",
    ".viz-swatch",
    ".viz-split",
    "560px tall",
    "tooltip with exact values",
    "never narrate previews",
    "write no text before or between tool calls",
  ])
    assert.ok(text.includes(phrase), phrase);
});

test("availability, scrubbed environment, and console caps", () => {
  assert.equal(
    new ChromiumPageRenderer({
      enabled: false,
      executablePath: process.execPath,
      logStartup: false,
    }).available(),
    false,
  );
  assert.equal(
    new ChromiumPageRenderer({
      enabled: true,
      executablePath: "/missing/chromium",
      logStartup: false,
    }).available(),
    false,
  );
  assert.equal(
    new ChromiumPageRenderer({
      enabled: true,
      executablePath: tmpdir(),
      logStartup: false,
    }).available(),
    false,
  );
  assert.equal(
    new ChromiumPageRenderer({
      enabled: true,
      executablePath: process.execPath,
      logStartup: false,
    }).available(),
    true,
  );
  const env = scrubbedChromiumEnv("/tmp/profile");
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_RUNTIME_DIR",
    ].sort(),
  );
  assert.equal(truncateConsole("error", "x".repeat(1000)).text.length, 500);
  assert.equal(truncateConsole("warning".repeat(10), "x").level.length, 20);
  assert.throws(
    () => rendererTempRoot("/mnt/state/browser"),
    /outside persistent state/,
  );
});

test("preview instructions appear only when the tool is registered", () => {
  assert.doesNotMatch(
    visualizationInstructions(false),
    /preview_visualization/,
  );
  assert.match(visualizationInstructions(true), /preview_visualization/);
});

test("preview schema rejects out-of-bounds and unexpected arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const renderer: PageRenderer = {
    available: () => true,
    preview: async (_html, options) => ({
      width: options?.width ?? 728,
      appearance: options?.appearance ?? "light",
      contentHeight: 100,
      capturedHeight: 100,
      consoleMessages: [],
      blockedRequests: [],
      missingImages: [],
    }),
    measure: async () => [],
  };
  const files = new ConversationFiles((id) => join(root, id), renderer);
  assert.ok(
    fileTools.some(
      (item) => (item as { name?: string }).name === "preview_visualization",
    ),
  );
  for (const args of [
    { html: "" },
    { html: "x".repeat(180001) },
    { html: "x", width: 239 },
    { html: "x", width: 1601 },
    { html: "x", width: 728.5 },
    { html: "x", extra: true },
    { html: "x", appearance: "pink" },
    { html: "x", appearance: "" },
    { html: "x", appearance: 1 },
  ])
    await assert.rejects(
      files.execute("a", "preview_visualization", args),
      /Invalid/,
    );
  assert.equal(
    (
      (await files.execute("a", "preview_visualization", {
        html: "x",
        width: 240,
      })) as any
    ).width,
    240,
  );
  // The theme to check is passed through; light is the default.
  const asked = async (args: object) =>
    (await files.execute("a", "preview_visualization", {
      html: "x",
      ...args,
    })) as any;
  assert.equal((await asked({ appearance: "dark" })).appearance, "dark");
  assert.equal((await asked({ appearance: "light" })).appearance, "light");
  assert.equal((await asked({})).appearance, "light");
  assert.deepEqual(await files.list("a"), []);
});

test("preview marker gates old conversations and keeps actionable failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new BusinessRuntime(
    "/missing/codex",
    root,
    undefined,
    undefined,
    {
      available: () => false,
      preview: async () => {
        throw new Error("not called");
      },
      measure: async () => [],
    },
  );
  const result = await runtime.executeTool({
    threadId: "old",
    tool: "preview_visualization",
    arguments: { html: "x" },
  });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /Start a new conversation/);
});

test("preview tool returns diagnostics and an image only for registered conversations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  await mkdir(join(root, "business-threads"));
  await writeFile(
    join(root, "business-threads", "new.json"),
    JSON.stringify({ cwd: work, documentTools: 1, visualPreviewTools: 1 }),
  );
  const runtime = new BusinessRuntime(
    "/missing/codex",
    root,
    undefined,
    undefined,
    {
      available: () => true,
      preview: async () => ({
        width: 728,
        appearance: "dark" as const,
        contentHeight: 200,
        capturedHeight: 200,
        consoleMessages: [],
        blockedRequests: [],
        missingImages: ["https://example.com/chart.png"],
        imageUrl: "data:image/png;base64,aGVsbG8=",
      }),
      measure: async () => [],
    },
  );
  const result = await runtime.executeTool({
    threadId: "new",
    tool: "preview_visualization",
    arguments: { html: "<p>Preview</p>" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.contentItems.map((item: any) => item.type),
    ["inputText", "inputImage"],
  );
  const diagnostics = JSON.parse(result.contentItems[0].text);
  assert.equal(diagnostics.contentHeight, 200);
  // The model is told which theme it saw and which pictures did not load.
  assert.equal(diagnostics.appearance, "dark");
  assert.deepEqual(diagnostics.missingImages, [
    "https://example.com/chart.png",
  ]);
  assert.equal("imageUrl" in diagnostics, false);
  assert.equal(
    (result.contentItems[1] as any).imageUrl,
    "data:image/png;base64,aGVsbG8=",
  );
  assert.equal((await runtime.files.list("new")).length, 0);
});

test("registered preview reports a missing browser without throwing into the turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "business-threads"));
  await writeFile(
    join(root, "business-threads", "new.json"),
    JSON.stringify({
      cwd: join(root, "work"),
      documentTools: 1,
      visualPreviewTools: 1,
    }),
  );
  const runtime = new BusinessRuntime(
    "/missing/codex",
    root,
    undefined,
    undefined,
    {
      available: () => false,
      preview: async () => {
        throw new Error("not called");
      },
      measure: async () => [],
    },
  );
  const result = await runtime.executeTool({
    threadId: "new",
    tool: "preview_visualization",
    arguments: { html: "<p>Preview</p>" },
  });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /VISUAL_RENDER.*CHROMIUM_PATH/);
});

test("publish stores bounded heights and warnings while revisions preserve old visuals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-heights-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ConversationFiles((id) => join(root, id), {
    available: () => true,
    preview: async () => {
      throw new Error("not called");
    },
    measure: async (_html, widths) =>
      Object.assign(
        widths
          .map((width) => [width, width + 10] as [number, number])
          .reverse(),
        { warnings: ["console error"] },
      ),
  });
  const args = {
    title: "Chart",
    description: "A chart",
    html: "<p>Chart</p>",
    height: 800,
  };
  const first = (await files.execute("a", "create_visualization", args)) as any;
  assert.deepEqual(first.warnings, ["console error"]);
  const visual = await files.visualization("a", first.id);
  assert.equal(visual.height, 800);
  assert.equal(visual.heights?.length, 9);
  assert.deepEqual(visual.heights?.[0], [320, 330]);
  const revised = (await files.execute("a", "create_visualization", {
    ...args,
    sourceId: first.id,
    html: "<p>Revised</p>",
  })) as any;
  assert.equal((await files.get("a", revised.id)).sourceId, first.id);
  assert.equal((await files.visualization("a", first.id)).html, args.html);
  await assert.rejects(
    files.execute("a", "create_visualization", { ...args, height: 79 }),
    /Invalid/,
  );
  await assert.rejects(
    files.execute("a", "create_visualization", { ...args, height: 2001 }),
    /Invalid/,
  );
});

test("publish succeeds without heights when rendering is missing or times out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { title: "Chart", description: "A chart", html: "<p>Chart</p>" };
  const missing = new ConversationFiles((id) => join(root, "missing", id));
  const off = (await missing.execute("a", "create_visualization", args)) as any;
  assert.deepEqual(Object.keys(off).sort(), ["id", "reference", "title"]);
  assert.equal((await missing.visualization("a", off.id)).heights, undefined);
  const failing = new ConversationFiles((id) => join(root, "failing", id), {
    available: () => true,
    preview: async () => {
      throw new Error("not called");
    },
    measure: async () => {
      throw new Error("timeout");
    },
  });
  const result = (await failing.execute(
    "a",
    "create_visualization",
    args,
  )) as any;
  assert.deepEqual(Object.keys(result).sort(), ["id", "reference", "title"]);
  assert.equal(
    (await failing.visualization("a", result.id)).heights,
    undefined,
  );
});
