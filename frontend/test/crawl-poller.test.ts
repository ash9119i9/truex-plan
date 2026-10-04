import assert from "node:assert/strict";
import { test } from "node:test";
import { createCrawlPoller } from "../lib/crawl-poller.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let current: (() => void) | undefined;
  const delays: number[] = [];
  return {
    delays,
    schedule(callback: () => void, delay: number) {
      current = callback;
      delays.push(delay);
      return 1 as any;
    },
    clear() {
      current = undefined;
    },
    tick() {
      const callback = current;
      current = undefined;
      callback?.();
    },
    pending() {
      return !!current;
    },
  };
}

test("reconnect loads persisted jobs, polls active jobs at3s and stops on terminal data", async () => {
  const time = clock();
  let calls = 0;
  const seen: string[] = [];
  const poller = createCrawlPoller<string>({
    load: async () => (++calls === 1 ? "running" : "completed"),
    active: (data) => data === "running",
    publish: (data) => seen.push(data),
    failed: (error) => assert.fail(String(error)),
    schedule: time.schedule,
    clear: time.clear,
  });
  poller.refresh();
  await settle();
  assert.deepEqual(seen, ["running"]);
  assert.deepEqual(time.delays, [3000]);
  time.tick();
  await settle();
  assert.deepEqual(seen, ["running", "completed"]);
  assert.equal(time.pending(), false);
  time.tick();
  poller.setVisible(false);
  poller.setVisible(true);
  await settle();
  assert.equal(calls, 2);
  poller.dispose();
});

test("hidden and unmounted views abort work, ignore stale results and resume active progress", async () => {
  const time = clock();
  const requests: { signal: AbortSignal; resolve: (data: string) => void }[] =
    [];
  const seen: string[] = [];
  const poller = createCrawlPoller<string>({
    load: (signal) =>
      new Promise<string>((resolve) => requests.push({ signal, resolve })),
    active: () => true,
    publish: (data) => seen.push(data),
    failed: (error) => assert.fail(String(error)),
    schedule: time.schedule,
    clear: time.clear,
  });
  poller.refresh();
  assert.equal(requests.length, 1);
  poller.setVisible(false);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve("stale");
  await settle();
  assert.deepEqual(seen, []);
  time.tick();
  assert.equal(requests.length, 1);
  poller.setVisible(true);
  assert.equal(requests.length, 2);
  requests[1].resolve("running");
  await settle();
  assert.deepEqual(seen, ["running"]);
  poller.setVisible(false);
  assert.equal(time.pending(), false);
  poller.setVisible(true);
  assert.equal(requests.length, 3);
  poller.dispose();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve("after unmount");
  await settle();
  assert.deepEqual(seen, ["running"]);
});

test("poll failures back off within30s and explicit cancel-refresh updates terminal state", async () => {
  const time = clock();
  let cancelled = false;
  let failures = 0;
  const seen: string[] = [];
  const poller = createCrawlPoller<string>({
    load: async () => {
      if (!cancelled) throw new Error("temporarily unavailable");
      return "cancelled";
    },
    active: () => false,
    publish: (data) => seen.push(data),
    failed: () => failures++,
    schedule: time.schedule,
    clear: time.clear,
  });
  poller.refresh();
  await settle();
  for (let i = 0; i < 5; i++) {
    time.tick();
    await settle();
  }
  assert.deepEqual(time.delays, [3000, 6000, 12000, 24000, 24000, 24000]);
  assert.equal(failures, 6);
  cancelled = true;
  poller.refresh();
  await settle();
  assert.deepEqual(seen, ["cancelled"]);
  assert.equal(time.pending(), false);
  poller.dispose();
});
