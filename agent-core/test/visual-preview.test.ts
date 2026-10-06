import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools, ConversationFiles } from "../src/file-tools";
import { ChromiumPageRenderer, scrubbedChromiumEnv, truncateConsole, type PageRenderer } from "../src/page-renderer";
import { visualizationDocument, visualizationExport } from "../../shared/visualization-document";
import { BusinessRuntime } from "../src/business-runtime";

const visual = {
  id: "12345678-1234-1234-1234-123456789abc",
  title: "Sales",
  description: "Sales by region",
  mode: "inline" as const,
  html: '<div id="chart">Chart</div><script>document.getElementById("chart").textContent="Ready"</script>',
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("shared document and export match the original frontend wrapper", () => {
  assert.equal(hash(visualizationDocument(visual, null)), "6e26b63a0efd55be984b8d0b0ad28e81eed165c775e735a277f4d86534eb449d");
  const escaped = { ...visual, title: "</title><script>titleAttack()</script>" };
  const state = { modelContent: "</script><script>stateAttack()</script>", privateContent: { unit: "₹", line: "\u2028" } };
  assert.equal(hash(visualizationDocument(escaped, state)), "a5e4e2df230f50dee31d367e98833666ec66740331a7b3978d4f9ba6161fd92e");
  assert.equal(hash(visualizationExport(escaped, state)), "952c228164c3bd2ee37579ab781c19047f412e3b394e2e7bd82e84dcdd58bd8a");
});

test("availability, scrubbed environment, and console caps", () => {
  assert.equal(new ChromiumPageRenderer({ enabled: false, executablePath: process.execPath, logStartup: false }).available(), false);
  assert.equal(new ChromiumPageRenderer({ enabled: true, executablePath: "/missing/chromium", logStartup: false }).available(), false);
  assert.equal(new ChromiumPageRenderer({ enabled: true, executablePath: process.execPath, logStartup: false }).available(), true);
  const env = scrubbedChromiumEnv("/tmp/profile");
  assert.deepEqual(Object.keys(env).sort(), ["LANG", "LC_ALL", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"].sort());
  assert.equal(truncateConsole("error", "x".repeat(1000)).text.length, 500);
  assert.equal(truncateConsole("warning".repeat(10), "x").level.length, 20);
});

test("preview schema rejects out-of-bounds and unexpected arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const renderer: PageRenderer = {
    available: () => true,
    preview: async (_html, options) => ({ width: options?.width ?? 728, contentHeight: 100, capturedHeight: 100, consoleMessages: [], blockedRequests: [] }),
    measure: async () => [],
  };
  const files = new ConversationFiles((id) => join(root, id), renderer);
  assert.ok(fileTools.some((item) => (item as { name?: string }).name === "preview_visualization"));
  for (const args of [{ html: "" }, { html: "x".repeat(180001) }, { html: "x", width: 239 }, { html: "x", width: 1601 }, { html: "x", width: 728.5 }, { html: "x", extra: true }])
    await assert.rejects(files.execute("a", "preview_visualization", args), /Invalid/);
  assert.equal((await files.execute("a", "preview_visualization", { html: "x", width: 240 }) as any).width, 240);
  assert.deepEqual(await files.list("a"), []);
});

test("preview marker gates old conversations and keeps actionable failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new BusinessRuntime("/missing/codex", root, undefined, undefined, {
    available: () => false,
    preview: async () => { throw new Error("not called"); },
    measure: async () => [],
  });
  const result = await runtime.executeTool({ threadId: "old", tool: "preview_visualization", arguments: { html: "x" } });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /Start a new conversation/);
});

test("publish stores bounded heights and warnings while revisions preserve old visuals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-heights-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ConversationFiles((id) => join(root, id), {
    available: () => true,
    preview: async () => { throw new Error("not called"); },
    measure: async (_html, widths) => Object.assign(widths.map((width) => [width, width + 10] as [number, number]).reverse(), { warnings: ["console error"] }),
  });
  const args = { title: "Chart", description: "A chart", html: "<p>Chart</p>", height: 800 };
  const first = await files.execute("a", "create_visualization", args) as any;
  assert.deepEqual(first.warnings, ["console error"]);
  const visual = await files.visualization("a", first.id);
  assert.equal(visual.height, 800);
  assert.equal(visual.heights?.length, 9);
  assert.deepEqual(visual.heights?.[0], [320, 330]);
  const revised = await files.execute("a", "create_visualization", { ...args, sourceId: first.id, html: "<p>Revised</p>" }) as any;
  assert.equal((await files.get("a", revised.id)).sourceId, first.id);
  assert.equal((await files.visualization("a", first.id)).html, args.html);
  await assert.rejects(files.execute("a", "create_visualization", { ...args, height: 79 }), /Invalid/);
  await assert.rejects(files.execute("a", "create_visualization", { ...args, height: 2001 }), /Invalid/);
});

test("publish succeeds without heights when rendering is missing or times out", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-preview-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { title: "Chart", description: "A chart", html: "<p>Chart</p>" };
  const missing = new ConversationFiles((id) => join(root, "missing", id));
  const off = await missing.execute("a", "create_visualization", args) as any;
  assert.deepEqual(Object.keys(off).sort(), ["id", "reference", "title"]);
  assert.equal((await missing.visualization("a", off.id)).heights, undefined);
  const failing = new ConversationFiles((id) => join(root, "failing", id), {
    available: () => true,
    preview: async () => { throw new Error("not called"); },
    measure: async () => { throw new Error("timeout"); },
  });
  const result = await failing.execute("a", "create_visualization", args) as any;
  assert.deepEqual(Object.keys(result).sort(), ["id", "reference", "title"]);
  assert.equal((await failing.visualization("a", result.id)).heights, undefined);
});
