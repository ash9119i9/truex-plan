import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOrderedBatch,
  type BatchScheduler,
} from "../lib/ordered-batch.ts";

function clock() {
  let nextId = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const scheduler: BatchScheduler = {
    requestFrame(run) {
      frames.set(++nextId, run);
      return nextId;
    },
    cancelFrame: (id) => void frames.delete(id),
    setTimer(run, delay) {
      assert.equal(delay, 50);
      timers.set(++nextId, run);
      return nextId;
    },
    clearTimer: (id) => void timers.delete(id as number),
  };
  const advance = (jobs: Map<number, () => void>) => {
    for (const [id, run] of [...jobs]) {
      jobs.delete(id);
      run();
    }
  };
  return {
    scheduler,
    frame: () => advance(frames),
    timer: () => advance(timers),
    pending: () => frames.size + timers.size,
  };
}

test("1000 delta frames publish once in original order and preserve all text", () => {
  const time = clock();
  const batches: string[][] = [];
  const batch = createOrderedBatch<string>(
    (items) => batches.push(items),
    time.scheduler,
  );
  const input = Array.from({ length: 1000 }, (_, i) => `${i},`);
  for (const item of input) batch.push(item);
  assert.equal(batches.length, 0);
  assert.equal(time.pending(), 2);
  time.frame();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].join(""), input.join(""));
  time.timer();
  assert.equal(batches.length, 1);
});

test("timer fallback publishes when animation frames do not run", () => {
  const time = clock();
  const batches: number[][] = [];
  const batch = createOrderedBatch<number>(
    (items) => batches.push(items),
    time.scheduler,
  );
  batch.push(1);
  time.timer();
  time.frame();
  assert.deepEqual(batches, [[1]]);
  assert.equal(time.pending(), 0);
});

test("flush and discard cancel stale scheduled callbacks", () => {
  const time = clock();
  const batches: number[][] = [];
  const batch = createOrderedBatch<number>(
    (items) => batches.push(items),
    time.scheduler,
  );
  batch.push(1);
  batch.flush();
  batch.push(2);
  batch.discard();
  time.frame();
  time.timer();
  assert.deepEqual(batches, [[1]]);
  assert.equal(time.pending(), 0);
});

test("queue count is bounded and reentrant publication retains new frames", () => {
  const time = clock();
  const batches: number[][] = [];
  const batch = createOrderedBatch<number>((items) => {
    batches.push(items);
    if (batches.length === 1) batch.push(9999);
  }, time.scheduler);
  for (let i = 0; i < 2048; i++) batch.push(i);
  assert.equal(batches[0].length, 2048);
  time.frame();
  assert.deepEqual(batches[1], [9999]);
});
