import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  DockerHtmlPreviewRunner,
  DisabledHtmlPreviewRunner,
  HttpHtmlPreviewRunner,
  htmlPreviewRunnerFromEnv,
  htmlPreviewContentItems,
  readHtmlPreviewResult,
  validateHtmlPreviewArguments,
} from "../src/html-preview";
import { createHtmlPreviewServer } from "../src/html-preview-server";
import type { SpawnFn } from "../src/script-runner";
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write("IHDR", 12);
png.writeUInt32BE(390, 16);
png.writeUInt32BE(300, 20);
const result = {
  width: 390,
  contentHeight: 300,
  capturedHeight: 300,
  durationMs: 1,
  consoleMessages: [],
  screenshot: {
    mimeType: "image/png",
    data: png.toString("base64"),
    width: 390,
    height: 300,
  },
};
const input = { html: "<p>chart</p>", width: 390, appearance: "dark" as const };
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}
function fake() {
  const jobs: FakeChild[] = [];
  const calls: string[][] = [];
  const spawn = ((_command: string, args: string[]) => {
    calls.push(args);
    const child = new FakeChild();
    if (args[0] === "rm") queueMicrotask(() => child.emit("close", 0));
    else jobs.push(child);
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls, jobs };
}
const complete = (child: FakeChild) => {
  child.stdout.write(JSON.stringify(result));
  child.emit("close", 0);
};
test("preview argument validation, disabled registration and PNG transport", () => {
  assert.deepEqual(validateHtmlPreviewArguments({ html: "<p>x</p>" }), {
    html: "<p>x</p>",
    width: 728,
    appearance: "dark",
  });
  for (const value of [
    null,
    [],
    { html: " " },
    { html: "x", width: NaN },
    { html: "x", width: 240.5 },
    { html: "x", width: 1601 },
    { html: "x", appearance: "blue" },
    { html: "x", tenant: "other" },
    { html: "x".repeat(180001) },
  ])
    assert.throws(() => validateHtmlPreviewArguments(value));
  assert.ok(htmlPreviewRunnerFromEnv({}) instanceof DisabledHtmlPreviewRunner);
  assert.ok(
    htmlPreviewRunnerFromEnv({ HTML_PREVIEW_RUNNER: "shell" }) instanceof
      DisabledHtmlPreviewRunner,
  );
  const valid = readHtmlPreviewResult(result);
  assert.equal(htmlPreviewContentItems(valid)[1].type, "inputImage");
  for (const bad of [
    { ...result, width: 300 },
    { ...result, capturedHeight: 4001 },
    { ...result, consoleMessages: [{ level: "error", text: "x".repeat(501) }] },
    { ...result, screenshot: { ...result.screenshot, data: "AAAA" } },
  ])
    assert.throws(() => readHtmlPreviewResult(bad));
});
test("Docker jobs have no network, mounts, secrets or host privileges and clean up", async () => {
  const f = fake(),
    runner = new DockerHtmlPreviewRunner({ spawn: f.spawn });
  const pending = runner.run(input);
  complete(f.jobs[0]);
  const got = await pending;
  assert.equal(got.width, 390);
  const args = f.calls[0];
  assert.ok(
    args.includes("none") &&
      args.includes("--read-only") &&
      args.includes("ALL") &&
      args.includes("no-new-privileges"),
  );
  assert.ok(
    !args.includes("-v") &&
      !args.includes("--mount") &&
      !args.includes("-e") &&
      !args.includes("--privileged"),
  );
  assert.equal(f.calls[1][0], "rm");
});
test("one active and four waiting; overflow, queued cancellation and scope fairness", async () => {
  const f = fake(),
    runner = new DockerHtmlPreviewRunner({ spawn: f.spawn });
  const controller = new AbortController();
  const promises = [
    runner.run({ ...input, scope: "a" }),
    runner.run({ ...input, scope: "b", signal: controller.signal }),
    ...Array.from({ length: 3 }, (_, i) =>
      runner.run({ ...input, scope: `q${i}` }),
    ),
  ];
  assert.deepEqual(runner.capacity, { active: 1, waiting: 4, healthy: true });
  await assert.rejects(
    runner.run({ ...input, scope: "extra" }),
    /queue is full/,
  );
  const cancelled = assert.rejects(promises[1], /cancelled/);
  controller.abort();
  await cancelled;
  complete(f.jobs[0]);
  await promises[0];
  for (let i = 2; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    complete(f.jobs.at(-1)!);
    await promises[i];
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.capacity.active, 0);
});
test("deadline and active cancellation force kill and cleanup", async () => {
  const f = fake(),
    runner = new DockerHtmlPreviewRunner({ spawn: f.spawn, timeoutMs: 10 });
  await assert.rejects(runner.run(input), /time limit/);
  assert.equal(f.calls[1][0], "rm");
  const controller = new AbortController();
  const pending = runner.run({ ...input, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.calls.at(-1)?.[0], "rm");
});

test("one conversation cannot occupy the queue and failed cleanup stops admission", async () => {
  const f = fake(),
    runner = new DockerHtmlPreviewRunner({ spawn: f.spawn });
  const active = runner.run({ ...input, scope: "same" }),
    queued = runner.run({ ...input, scope: "same" });
  await assert.rejects(
    runner.run({ ...input, scope: "same" }),
    /queue is full/,
  );
  complete(f.jobs[0]);
  await active;
  await new Promise((resolve) => setImmediate(resolve));
  complete(f.jobs[1]);
  await queued;
  const broken = ((_command: string, args: string[]) => {
    const child = new FakeChild();
    if (args[0] === "rm") queueMicrotask(() => child.emit("close", 1));
    else queueMicrotask(() => complete(child));
    return child;
  }) as unknown as SpawnFn;
  const stopped = new DockerHtmlPreviewRunner({ spawn: broken });
  await assert.rejects(stopped.run(input), /cleanup failed/);
  assert.equal(stopped.capacity.healthy, false);
  await assert.rejects(stopped.run(input), /operator recovery/);
});
test("private supervisor authenticates and HTTP runner delivers bounded image", async (t) => {
  const secret = "k".repeat(32);
  let received: any;
  const server = createHtmlPreviewServer(secret, {
    enabled: true,
    async run(value) {
      received = value;
      return readHtmlPreviewResult(result);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/preview`;
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  const runner = new HttpHtmlPreviewRunner(url, secret);
  const got = await runner.run({ ...input, scope: "conversation" });
  assert.equal(got.screenshot.data, result.screenshot.data);
  assert.equal(received.scope, "conversation");
  assert.ok(received.signal instanceof AbortSignal);
  await assert.rejects(
    new HttpHtmlPreviewRunner(
      url,
      secret,
      async () => new Response("x".repeat(6 * 1024 * 1024 + 1)),
    ).run(input),
    /exceeded/,
  );
  await assert.rejects(
    new HttpHtmlPreviewRunner(
      url,
      secret,
      async () => new Response(JSON.stringify({ ...result, width: 728 })),
    ).run(input),
    /invalid/,
  );
});
