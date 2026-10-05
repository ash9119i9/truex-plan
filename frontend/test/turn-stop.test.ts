import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnStop } from "../lib/turn-stop.ts";

test("stop immediately blocks duplicate attempts and running snapshots do not unlock it", () => {
  const stop = new TurnStop();
  stop.observe({ kind: "running", turnId: "a" });
  const attempt = stop.begin()!;
  assert.equal(stop.begin(), null);
  stop.observe({ kind: "running", turnId: "a" });
  assert.equal(stop.status, "pending");
  assert.equal(stop.current(attempt), true);
});

test("unconfirmed stops remain blocked but permit a retry; old failures cannot affect the retry", () => {
  const stop = new TurnStop();
  stop.observe({ kind: "running", turnId: "a" });
  const first = stop.begin()!;
  assert.equal(stop.fail(first), true);
  assert.equal(stop.status, "unconfirmed");
  const retry = stop.begin()!;
  assert.equal(stop.fail(first), false);
  assert.equal(stop.current(retry), true);
  assert.equal(stop.status, "pending");
});

test("completion wins over a delayed HTTP failure and unrelated completion cannot unlock", () => {
  const stop = new TurnStop();
  stop.observe({ kind: "running", turnId: "a" });
  const attempt = stop.begin()!;
  assert.equal(stop.observe({ kind: "idle" }, "older-turn"), false);
  assert.equal(stop.status, "pending");
  assert.equal(stop.observe({ kind: "idle" }, "a"), true);
  assert.equal(stop.fail(attempt), false);
  assert.equal(stop.status, null);
});

test("reconnect restores stop state and defaults older interrupting snapshots to pending", () => {
  const stop = new TurnStop();
  stop.observe({ kind: "interrupting", turnId: "a" });
  assert.equal(stop.status, "pending");
  stop.observe(
    { kind: "interrupting", turnId: "a", stopStatus: "unconfirmed" },
    "a",
  );
  assert.equal(stop.status, "unconfirmed");
  assert.notEqual(stop.begin(), null);
});

test("session reset and a newer turn fence previous Stop responses", () => {
  const stop = new TurnStop();
  stop.observe({ kind: "running", turnId: "a" });
  const first = stop.begin()!;
  stop.observe({ kind: "running", turnId: "b" });
  assert.equal(stop.current(first), false);
  assert.equal(stop.observe({ kind: "idle" }, "a"), false);
  const second = stop.begin()!;
  stop.reset();
  assert.equal(stop.fail(second), false);
  assert.equal(stop.status, null);
});

test("Stop during startup remains pending when the turn ID becomes known", () => {
  const stop = new TurnStop();
  stop.observe({ kind: "starting" });
  const attempt = stop.begin()!;
  stop.observe({ kind: "running", turnId: "a" });
  assert.equal(stop.status, "pending");
  assert.equal(stop.current(attempt), true);
  stop.observe({ kind: "idle" }, "a");
  assert.equal(stop.status, null);
});
