import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionHistory } from "../lib/session-history.ts";

test("opening and resync share recovery, while persisted reads remain independent", async () => {
  const calls: [string, boolean][] = [];
  const resolvers: ((value: string) => void)[] = [];
  const history = new SessionHistory<string>((id, persisted) => {
    calls.push([id, persisted]);
    return new Promise((resolve) => resolvers.push(resolve));
  });
  const opening = history.load("a");
  assert.equal(history.load("a"), opening);
  const saved = history.load("a", true);
  const other = history.load("b");
  await Promise.resolve();
  assert.deepEqual(calls, [
    ["a", false],
    ["a", true],
    ["b", false],
  ]);
  resolvers.forEach((resolve, i) => resolve(String(i)));
  assert.deepEqual(await Promise.all([opening, saved, other]), ["0", "1", "2"]);
  const fresh = history.load("a");
  assert.notEqual(fresh, opening);
  await Promise.resolve();
  resolvers[3]("fresh");
  assert.equal(await fresh, "fresh");
});

test("failed and synchronously throwing reads are retryable without orphan rejections", async () => {
  let attempts = 0;
  const history = new SessionHistory<string>(() => {
    if (++attempts === 1) throw new Error("unavailable");
    return Promise.resolve("restored");
  });
  const first = history.load("a");
  assert.equal(history.load("a"), first);
  await assert.rejects(first, /unavailable/);
  assert.equal(await history.load("a"), "restored");
  assert.equal(attempts, 2);
});

test("opening starts saved and recovery reads together and retains fast completed recovery", async () => {
  const calls: [string, boolean][] = [];
  let saved!: (value: string) => void;
  const history = new SessionHistory<string>((id, persisted) => {
    calls.push([id, persisted]);
    return persisted
      ? new Promise((resolve) => {
          saved = resolve;
        })
      : Promise.resolve("live");
  });
  const opening = history.loadForOpen("a");
  assert.equal(history.load("a"), opening.recovery);
  await Promise.resolve();
  assert.deepEqual(calls, [
    ["a", true],
    ["a", false],
  ]);
  assert.equal(await opening.recovery, "live");
  saved("saved");
  assert.equal(await opening.persisted, "saved");
  assert.equal(await opening.recovery, "live");
  assert.equal(calls.length, 2);
});

test("early recovery failure remains observable after slow saved history", async () => {
  let saved!: (value: string) => void;
  const history = new SessionHistory<string>((_id, persisted) =>
    persisted
      ? new Promise((resolve) => {
          saved = resolve;
        })
      : Promise.reject(new Error("recovery denied")),
  );
  const opening = history.loadForOpen("a");
  // Let Node check for orphan rejections before the normal consumer awaits it.
  await new Promise((resolve) => setImmediate(resolve));
  saved("saved");
  assert.equal(await opening.persisted, "saved");
  await assert.rejects(opening.recovery, /recovery denied/);
  const retry = history.load("a", true);
  await Promise.resolve();
  saved("retry");
  assert.equal(await retry, "retry");
});

test("failed saved reads leave recovery rejection handled and a new opening retryable", async () => {
  let fail = true;
  const history = new SessionHistory<string>((_id, persisted) => {
    if (fail) throw new Error(persisted ? "saved denied" : "recovery denied");
    return Promise.resolve(persisted ? "saved" : "live");
  });
  const opening = history.loadForOpen("a");
  await assert.rejects(opening.persisted, /saved denied/);
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  const retry = history.loadForOpen("a");
  assert.deepEqual(await Promise.all([retry.persisted, retry.recovery]), [
    "saved",
    "live",
  ]);
});
