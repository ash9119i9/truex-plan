import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ChromiumPageRenderer, MEASURE_WIDTHS } from "../src/page-renderer";
import { ConversationFiles } from "../src/file-tools";

const executablePath = process.env.CHROMIUM_PATH || "";
let browserReady = false;
try {
  accessSync(executablePath, constants.X_OK);
  browserReady = true;
} catch {
  // The host does not have a usable system Chromium; run this file in the x86 test image.
}
const browserTest = (name: string, fn: () => Promise<void>) =>
  test(
    name,
    {
      skip: browserReady ? false : "CHROMIUM_PATH is absent or not executable",
    },
    fn,
  );
const renderer = () =>
  new ChromiumPageRenderer({
    enabled: true,
    executablePath,
    noSandbox: process.env.CHROMIUM_NO_SANDBOX === "1",
    logStartup: false,
  });
const profiles = async () =>
  (await readdir(tmpdir())).filter((name) =>
    name.startsWith("truex-visual-render-"),
  );
const processes = () =>
  spawnSync("ps", ["-e", "-o", "stat=,comm="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => /\b(chromium|chrome)\b/.test(line));
const childBrowserPids = () =>
  spawnSync("ps", ["-e", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === process.pid &&
        /^(chromium|chrome)$/.test(parts[2]),
    )
    .map((parts) => Number(parts[0]));

browserTest(
  "real Chromium measures content, errors and screenshot cap",
  async () => {
    const before = await profiles();
    const r = renderer();
    const page = await r.preview(
      '<svg width="100%" height="2000"><rect width="100%" height="2000" fill="red"/></svg><script>console.error("sample error")</script>',
      { width: 728 },
    );
    assert.ok(
      page.contentHeight >= 2000 && page.contentHeight <= 2100,
      String(page.contentHeight),
    );
    assert.match(page.imageUrl || "", /^data:image\/png;base64,/);
    assert.ok(
      page.consoleMessages.some((message) =>
        message.text.includes("sample error"),
      ),
    );
    const tall = await r.preview('<div style="height:5000px">Tall</div>');
    assert.equal(tall.capturedHeight, 4000);
    assert.ok(tall.contentHeight >= 5000);
    const heights = await r.measure(
      '<div style="height:200px">Measured</div>',
      MEASURE_WIDTHS,
    );
    assert.equal(heights.length, 9);
    assert.deepEqual(
      heights.map(([width]) => width),
      [...MEASURE_WIDTHS],
    );
    assert.deepEqual(await profiles(), before);
  },
);

browserTest(
  "CSP and interception report remote fetch, script and image without egress",
  async () => {
    const page = await renderer().preview(
      '<script>fetch("https://example.invalid/fetch").catch(()=>{});</script><script src="https://example.invalid/code.js"></script><img src="https://example.invalid/pixel.png">',
    );
    assert.ok(
      page.blockedRequests.some((url) => url.includes("fetch")),
      JSON.stringify(page.blockedRequests),
    );
    assert.ok(
      page.blockedRequests.some((url) => url.includes("code.js")),
      JSON.stringify(page.blockedRequests),
    );
    assert.ok(
      page.blockedRequests.some((url) => url.includes("pixel.png")),
      JSON.stringify(page.blockedRequests),
    );
    assert.ok(page.blockedRequests.length <= 20);
  },
);

browserTest("navigation attempt cannot fetch a remote page", async () => {
  const before = await profiles();
  const result = await renderer().preview(
    '<script>location.href="https://example.invalid/navigation"</script>',
  );
  assert.ok(result.blockedRequests.some((url) => url.includes("navigation")));
  assert.deepEqual(await profiles(), before);
});

browserTest(
  "infinite loop times out and leaves no browser process or profile",
  async () => {
    const beforeProfiles = await profiles();
    const beforeProcesses = processes().length;
    await assert.rejects(
      renderer().preview("<script>while(true){}</script>"),
      /timed out/i,
    );
    assert.deepEqual(await profiles(), beforeProfiles);
    assert.equal(processes().length, beforeProcesses);
  },
);

browserTest(
  "measurement has a six-second total timeout and cleans up",
  async () => {
    const beforeProfiles = await profiles();
    const beforeProcesses = processes().length;
    const started = Date.now();
    await assert.rejects(
      renderer().measure("<script>while(true){}</script>", MEASURE_WIDTHS),
      /timed out/i,
    );
    assert.ok(Date.now() - started < 8000);
    assert.deepEqual(await profiles(), beforeProfiles);
    assert.equal(processes().length, beforeProcesses);
  },
);

browserTest(
  "bounded queue fails fast while two previews and a publish measurement run",
  async () => {
    const r = renderer();
    const root = await mkdtemp(join(tmpdir(), "truex-preview-concurrency-"));
    const files = new ConversationFiles((id) => join(root, id), r);
    const slow =
      "<script>const until=Date.now()+1500;while(Date.now()<until){}</script><p>Done</p>";
    try {
      const first = r.preview(slow);
      const second = r.preview(slow);
      const publish = files.execute("thread", "create_visualization", {
        title: "Concurrent",
        description: "Concurrent visual",
        html: slow,
      });
      for (
        let attempt = 0;
        attempt < 50 && (await files.list("thread")).length === 0;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const fourth = r.preview(slow);
      const started = Date.now();
      await assert.rejects(r.preview(slow), /busy/i);
      assert.ok(Date.now() - started < 1000);
      const [, , result] = await Promise.all([first, second, publish, fourth]);
      assert.equal(
        (await files.visualization("thread", (result as any).id)).heights
          ?.length,
        9,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

browserTest(
  "dialogs, popup attempts, canvas allocation, console flood and large DOM stay bounded",
  async () => {
    const html = `<script>
    console.error("popup-opened:" + Boolean(window.open("https://example.invalid/popup")));
    alert("dismiss me"); console.error("confirm-result:" + confirm("dismiss me too"));
    for (let i = 0; i < 200; i++) console.error("flood " + i + " ".repeat(200));
    const canvas = document.createElement("canvas"); canvas.width = 100000; canvas.height = 100000;
    try { canvas.getContext("2d"); } catch (error) { console.error(String(error)); }
    const group = document.createDocumentFragment();
    for (let i = 0; i < 20000; i++) group.appendChild(document.createElement("span"));
    document.body.appendChild(group);
  </script>`;
    const result = await renderer().preview(html);
    assert.ok(result.consoleMessages.length <= 20);
    assert.ok(
      result.consoleMessages.some((message) =>
        message.text.includes("popup-opened:false"),
      ),
      JSON.stringify(result.consoleMessages.slice(0, 5)),
    );
    assert.ok(
      result.consoleMessages.some((message) =>
        message.text.includes("confirm-result:false"),
      ),
    );
    assert.ok(
      result.consoleMessages.every((message) => message.text.length <= 500),
    );
    assert.ok(result.contentHeight > 0);
  },
);

browserTest(
  "browser crash mid-render cleans its process group and profile",
  async () => {
    const beforeProfiles = await profiles();
    const beforeProcesses = processes().length;
    const pending = renderer().preview("<script>while(true){}</script>");
    let pid: number | undefined;
    for (let attempt = 0; attempt < 30 && !pid; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      pid = childBrowserPids()[0];
    }
    assert.ok(pid, "renderer spawned a browser child");
    process.kill(pid, "SIGKILL");
    await assert.rejects(pending, /browser|render|timed out/i);
    assert.deepEqual(await profiles(), beforeProfiles);
    assert.equal(processes().length, beforeProcesses);
  },
);

browserTest(
  "fifty sequential renders leave no zombie Chromium processes",
  async () => {
    const before = processes().filter((line) => /^\s*Z/.test(line)).length;
    const r = renderer();
    for (let index = 0; index < 50; index++)
      await r.preview(`<p>Render ${index}</p>`);
    const after = processes().filter((line) => /^\s*Z/.test(line)).length;
    assert.equal(after - before, 0, `zombie delta ${after - before}`);
  },
);
