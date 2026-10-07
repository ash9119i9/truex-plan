import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  DockerHtmlPreviewRunner,
  HttpHtmlPreviewRunner,
} from "../src/html-preview";
import { createHtmlPreviewServer } from "../src/html-preview-server";
import { prepareVisualizationDocument } from "../../shared/visualization-document";
import type { SpawnFn } from "../src/script-runner";
const docker = promisify(execFile);
const enabled = process.env.HTML_PREVIEW_DOCKER_TEST === "1";
const image = process.env.HTML_PREVIEW_IMAGE ?? "truex-html-preview:local";
const prepare = (html: string, appearance: "light" | "dark" = "dark") =>
  prepareVisualizationDocument(
    { title: "Test visual", html, sourceFormat: "document" },
    null,
    { appearance },
  );
test(
  "real ARM64 Chromium renders prepared document, bounded console and network isolation",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    const runner = new DockerHtmlPreviewRunner({ image });
    const html =
      prepare(`<!doctype html><html><head><style>body{margin:0}#chart{height:300px;background:var(--viz-series-1)}</style></head><body><div id="chart">Quarterly revenue</div><script>
  console.log('theme',getComputedStyle(document.documentElement).getPropertyValue('--background'));
  fetch('https://example.com/private').then(()=>console.error('REMOTE_LEAK')).catch(()=>console.log('remote denied'));
  fetch('http://169.254.169.254/latest/meta-data/').then(()=>console.error('METADATA_LEAK')).catch(()=>console.log('metadata denied'));
  fetch('file:///etc/passwd').then(()=>console.error('FILE_LEAK')).catch(()=>console.log('file denied'));
  console.warn('chart warning');throw new Error('chart error');</script></body></html>`);
    const result = await runner.run({
      html,
      width: 390,
      appearance: "dark",
      scope: "real",
    });
    assert.ok(Buffer.from(result.screenshot.data, "base64").length > 1000);
    assert.equal(result.width, 390);
    assert.ok(result.contentHeight >= 300);
    const logs = result.consoleMessages.map((c) => c.text).join("\n");
    assert.match(logs, /remote denied/);
    assert.match(logs, /metadata denied/);
    assert.match(logs, /file denied/);
    assert.match(logs, /chart error/);
    assert.doesNotMatch(logs, /REMOTE_LEAK|METADATA_LEAK|FILE_LEAK/);
    console.log(
      JSON.stringify({
        previewBenchmark: {
          width: 390,
          durationMs: result.durationMs,
          pngBytes: Buffer.from(result.screenshot.data, "base64").length,
          contentHeight: result.contentHeight,
        },
      }),
    );
    const light = await runner.run({
      html: prepare(
        '<!doctype html><html><body><p>Light</p><script>for(let i=0;i<100;i++)console.log("x".repeat(1000));</script></body></html>',
        "light",
      ),
      width: 728,
      appearance: "light",
      scope: "real",
    });
    assert.equal(light.consoleMessages.length, 20);
    assert.ok(light.consoleMessages.every((c) => c.text.length <= 500));
  },
);
test(
  "real infinite script and cancelled render terminate owned containers",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    const runner = new DockerHtmlPreviewRunner({ image, timeoutMs: 2000 });
    const started = Date.now();
    await assert.rejects(
      runner.run({
        html: prepare(
          "<!doctype html><html><body><script>while(true){}</script></body></html>",
        ),
        width: 390,
        appearance: "dark",
        scope: "hostile",
      }),
      /time limit/,
    );
    assert.ok(Date.now() - started < 7000);
    const controller = new AbortController();
    const pending = runner.run({
      html: prepare("<html><body><script>while(true){}</script></body></html>"),
      width: 390,
      appearance: "dark",
      scope: "hostile",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(pending, /cancelled/);
    const { stdout } = await docker("docker", [
      "ps",
      "-a",
      "--filter",
      "name=truex-preview-",
      "--format",
      "{{.Names}}",
    ]);
    assert.equal(stdout.trim(), "");
  },
);
test(
  "real queue overload and renderer CPU/memory measurement",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    let name = "";
    const tracked = ((command: string, args: string[], options: any) => {
      if (args[0] === "run" && !name) name = args[args.indexOf("--name") + 1];
      return spawn(command, args, options);
    }) as SpawnFn;
    const runner = new DockerHtmlPreviewRunner({ image, spawn: tracked });
    const html = prepare(
      '<!doctype html><html><body><div style="height:250px">Load fixture</div><script>const until=Date.now()+2000;while(Date.now()<until){Math.sqrt(Math.random());}</script></body></html>',
    );
    const started = Date.now();
    const pending = Array.from({ length: 5 }, (_, i) =>
      runner.run({ html, width: 390, appearance: "dark", scope: `bench${i}` }),
    );
    await assert.rejects(
      runner.run({ html, width: 390, appearance: "dark", scope: "overflow" }),
      /queue is full/,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const sample = await docker("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.MemUsage}}|{{.CPUPerc}}",
      name,
    ]);
    const results = await Promise.all(pending);
    console.log(
      JSON.stringify({
        queueBenchmark: {
          jobs: 5,
          rejected: 1,
          elapsedMs: Date.now() - started,
          jobDurationsMs: results.map((r) => r.durationMs),
          sample: sample.stdout.trim(),
        },
      }),
    );
    const remaining = await docker("docker", [
      "ps",
      "-a",
      "--filter",
      "name=truex-preview-",
      "--format",
      "{{.Names}}",
    ]);
    assert.equal(remaining.stdout.trim(), "");
  },
);

test(
  "private HTTP deployment path delivers real PNG and cancels Docker job on disconnect",
  { skip: !enabled, timeout: 15_000 },
  async (t) => {
    const secret = "private-fixture-key".repeat(2),
      dockerRunner = new DockerHtmlPreviewRunner({ image });
    const server = createHtmlPreviewServer(secret, dockerRunner);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address() as { port: number };
    const runner = new HttpHtmlPreviewRunner(
      `http://127.0.0.1:${address.port}/preview`,
      secret,
    );
    const screenshot = await runner.run({
      html: prepare("<html><body><h1>HTTP preview</h1></body></html>"),
      width: 390,
      appearance: "dark",
      scope: "http",
    });
    assert.ok(Buffer.from(screenshot.screenshot.data, "base64").length > 1000);
    const controller = new AbortController();
    const pending = runner.run({
      html: prepare("<html><body><script>while(true){}</script></body></html>"),
      width: 390,
      appearance: "dark",
      scope: "http",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(pending, /cancelled/);
    // Wait for the supervisor's asynchronous disconnect cleanup using a normal
    // admitted job as the fence, rather than polling or a fixed recovery sleep.
    await runner.run({
      html: prepare("<html><body>After cancellation</body></html>"),
      width: 390,
      appearance: "dark",
      scope: "after",
    });
    const remaining = await docker("docker", [
      "ps",
      "-a",
      "--filter",
      "name=truex-preview-",
      "--format",
      "{{.Names}}",
    ]);
    assert.equal(remaining.stdout.trim(), "");
  },
);

test(
  "worker TTL reclaims a job after its supervising Docker client dies",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    const name = `truex-preview-orphan-fixture-${process.pid}`;
    const runner = new DockerHtmlPreviewRunner({ image });
    const child = spawn("docker", runner.dockerArgs(name), {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.end(
      JSON.stringify({
        html: prepare(
          '<html><body><script>Object.defineProperty(document.fonts,"ready",{value:new Promise(()=>{})});</script></body></html>',
        ),
        width: 390,
        appearance: "dark",
      }),
    );
    // Inspect retries only until our captured, uniquely named job exists. This
    // never touches other containers and simulates loss of its supervisor.
    let found = false;
    for (let i = 0; i < 10; i++) {
      try {
        const inspected = await docker("docker", [
          "inspect",
          "--format",
          "{{.State.Running}}",
          name,
        ]);
        if (inspected.stdout.trim() === "true") {
          found = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(found);
    child.kill("SIGKILL");
    const started = Date.now();
    const waited = await docker("docker", ["wait", name], { timeout: 25_000 });
    assert.equal(waited.stdout.trim(), "124");
    assert.ok(Date.now() - started < 23_000);
    const remaining = await docker("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${name}`,
      "--format",
      "{{.Names}}",
    ]);
    assert.equal(remaining.stdout.trim(), "");
  },
);
