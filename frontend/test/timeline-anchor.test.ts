import { test } from "node:test";
import assert from "node:assert/strict";
import { timelineAnchorIndex } from "../lib/timeline-anchor.ts";
import type { Entry } from "../lib/chat.ts";

const transcript: Entry[] = [
  { kind: "message", id: "u1", role: "user", text: "first" },
  {
    kind: "message",
    id: "a1",
    role: "assistant",
    text: "answer",
    turnId: "t1",
    final: true,
  },
  { kind: "message", id: "u2", role: "user", text: "steer", turnId: "t1" },
  {
    kind: "agents",
    id: "agents:t1/helper",
    turnId: "t1",
    threadIds: ["helper"],
  },
  {
    kind: "message",
    id: "a2",
    role: "assistant",
    text: "answer2",
    turnId: "t1",
    final: true,
  },
];
test("virtual navigation resolves user, first turn and helper anchors across steering", () => {
  assert.equal(timelineAnchorIndex(transcript, "request-u1"), 0);
  assert.equal(timelineAnchorIndex(transcript, "turn-t1"), 1);
  assert.equal(timelineAnchorIndex(transcript, "helpers-agents-t1-helper"), 3);
  assert.equal(timelineAnchorIndex(transcript, "request-u2"), 2);
});
test("missing and unloaded turns remain explicit; prepends move the same anchor", () => {
  assert.equal(timelineAnchorIndex([], "turn-t1"), undefined);
  assert.equal(timelineAnchorIndex(transcript, "turn-missing"), undefined);
  const older: Entry[] = [
    { kind: "message", id: "older", role: "user", text: "old" },
  ];
  assert.equal(timelineAnchorIndex([...older, ...transcript], "turn-t1"), 2);
});
