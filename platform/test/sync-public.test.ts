import { test } from "node:test";
import assert from "node:assert/strict";
import { publicEvent, PublicEventStream } from "../src/public";

const marker = () => ({
  type: "sync.completed",
  cursor: "g:42",
  data: {
    protocol: 1,
    mode: "replay",
    fromCursor: "g:41",
    highWaterCursor: "g:42",
    snapshot: {
      cursor: "g:42",
      state: { kind: "running", turnId: "turn" },
      messages: [],
      thinking: [],
      privateTranscript: "private unwanted transcript",
      pending: [
        {
          requestId: "r",
          method: "item/tool/requestUserInput",
          detail: {
            questions: [
              {
                id: "q",
                question: "Continue?",
                header: "Next",
                options: [],
                private: "secret",
              },
            ],
          },
          private: "secret",
        },
      ],
      plan: [{ step: "Review", status: "in_progress" }],
      goal: null,
      private: "secret",
    },
    private: "secret",
  },
});
test("a malformed synchronized frame cannot be skipped before a valid high-water marker", () => {
  const frames = `data: {broken\n\ndata: ${JSON.stringify(marker())}\n\n`;
  const strict = new PublicEventStream(undefined, true);
  assert.throws(() => strict.push(Buffer.from(frames)));
  // Legacy projection behavior remains opt-in compatible.
  assert.match(
    new PublicEventStream().push(Buffer.from(frames)),
    /sync.completed/,
  );
  const observer = new PublicEventStream(() => {
    throw new Error("observer failed");
  }, true);
  assert.throws(
    () => observer.push(Buffer.from(`data: ${JSON.stringify(marker())}\n\n`)),
    /observer failed/,
  );
});
test("synchronization marker exposes only authoritative operational projection", () => {
  const event = publicEvent(marker());
  assert.equal(event.cursor, "g:42");
  assert.deepEqual(event.data.snapshot.state, {
    kind: "running",
    turnId: "turn",
  });
  assert.equal(event.data.snapshot.pending[0].requestId, "r");
  assert.deepEqual(event.data.snapshot.messages, []);
  assert.deepEqual(event.data.snapshot.thinking, []);
  assert.equal(JSON.stringify(event).includes("secret"), false);
  assert.equal(JSON.stringify(event).includes("private"), false);
});
test("unsupported or incoherent markers never become public completion", () => {
  for (const patch of [
    { protocol: 2 },
    { mode: "unknown" },
    { highWaterCursor: "g:43" },
    { fromCursor: 42 },
    { snapshot: null },
    { snapshot: { cursor: "g:40" } },
    { snapshot: { cursor: "g:42" } },
    { snapshot: { ...marker().data.snapshot, state: undefined } },
    { snapshot: { ...marker().data.snapshot, state: { kind: "unknown" } } },
    { snapshot: { ...marker().data.snapshot, state: { kind: "running" } } },
    { snapshot: { ...marker().data.snapshot, pending: undefined } },
    { snapshot: { ...marker().data.snapshot, pending: {} } },
    {
      snapshot: {
        ...marker().data.snapshot,
        messages: [{ text: "unexpected" }],
      },
    },
  ]) {
    const event = marker();
    Object.assign(event.data, patch);
    assert.equal(publicEvent(event), null);
  }
});
