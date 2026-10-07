import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChatEvent,
  historyEntries,
  mergeHistoryEntries,
  mergeHistoryWindow,
  type Entry,
} from "../lib/chat.ts";
import { createChatGroupSelector } from "../lib/chat-groups.ts";
import { splitVisualizations } from "../lib/visualization.ts";
import type { DomainEvent, Message } from "../../shared/contracts.ts";
import type { VisualAttachment } from "../../shared/visualizations.ts";

const visual: VisualAttachment = {
  id: "12345678-1234-1234-1234-123456789abc",
  title: "Sales",
  description: "Monthly sales",
  turnId: "turn",
  callId: "call",
  height: 400,
};
const marker = `[truex-visualization:${visual.id}]`;
const event = (type: DomainEvent["type"], data: Record<string, unknown>) =>
  ({ type, data, turnId: "turn", itemId: "answer" }) as DomainEvent;
const publication = event("visual.published", { visual });
const savedVisual = (value: VisualAttachment = visual): Message =>
  ({
    _id: `session:visual:${value.id}`,
    sessionId: "session",
    role: "assistant",
    text: "",
    turnId: value.turnId,
    visuals: [value],
    at: "2026-10-07T00:00:00.000Z",
  }) as Message;
const savedAnswer = (text = "Here is the chart."): Message =>
  ({
    _id: "answer",
    sessionId: "session",
    role: "assistant",
    text,
    turnId: "turn",
    runtimeItemId: "answer",
    messageIndex: 0,
    at: "2026-10-07T00:00:01.000Z",
  }) as Message;
const visualEntries = (entries: Entry[]) =>
  entries.filter((entry) => entry.kind === "visual");

test("a publication renders before prose and survives artifact-only interrupted turns", () => {
  let entries = applyChatEvent([], publication);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "visual");
  entries = applyChatEvent(entries, event("turn.completed", {}));
  assert.equal(visualEntries(entries).length, 1);
  const restored = historyEntries([savedVisual()]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].kind, "visual");
  assert.deepEqual(
    createChatGroupSelector()(restored)[0].entries.map((entry) => entry.kind),
    ["visual"],
  );
});
test("publication, history, snapshot and replay converge on one visual without remounting", () => {
  const initial = applyChatEvent([], publication);
  const entry = initial[0];
  assert.equal(applyChatEvent(initial, publication), initial);
  assert.equal(
    applyChatEvent(
      initial,
      event("snapshot", { visuals: [{ ...visual }], messages: [] }),
    )[0],
    entry,
  );
  assert.equal(
    applyChatEvent(
      initial,
      event("sync.completed", { snapshot: { visuals: [{ ...visual }] } }),
    ),
    initial,
  );
  const merged = mergeHistoryWindow(
    [savedVisual(), savedAnswer(marker)],
    initial,
  );
  assert.equal(visualEntries(merged).length, 1);
  assert.equal(merged[0], entry);
  assert.equal(
    mergeHistoryWindow([savedVisual(), savedAnswer(marker)], merged),
    merged,
  );
  const reconnected = mergeHistoryEntries(
    [savedVisual(), savedAnswer(marker)],
    merged,
  );
  assert.equal(visualEntries(reconnected).length, 1);
  const group = createChatGroupSelector()(reconnected)[0];
  assert.deepEqual(splitVisualizations(marker, false, group.visualIds), []);
});
test("late publications and reconciled history belong before the saved answer", () => {
  const answer = historyEntries([savedAnswer()]);
  const arrived = applyChatEvent(answer, publication);
  assert.deepEqual(
    arrived.map((entry) => entry.kind),
    ["visual", "message"],
  );
  const reconciled = historyEntries([savedAnswer(), savedVisual()]);
  assert.deepEqual(
    reconciled.map((entry) => entry.kind),
    ["visual", "message"],
  );
  const paged = mergeHistoryWindow([savedVisual()], answer, { older: true });
  assert.deepEqual(
    paged.map((entry) => entry.kind),
    ["visual", "message"],
  );
  assert.equal(
    mergeHistoryWindow([savedVisual()], paged, { older: true }),
    paged,
  );
});
test("distinct calls stay separate and markers suppress only their owning turn", () => {
  const second = {
    ...visual,
    id: "12345678-1234-1234-1234-123456789abd",
    callId: "second",
  };
  const otherTurn = {
    ...visual,
    id: "12345678-1234-1234-1234-123456789abe",
    callId: "third",
    turnId: "next",
  };
  const entries = historyEntries([
    savedVisual(),
    savedVisual(second),
    savedAnswer(marker),
    savedVisual(otherTurn),
  ]);
  assert.equal(visualEntries(entries).length, 3);
  const groups = createChatGroupSelector()(entries);
  assert.deepEqual(groups[0].visualIds, [visual.id, second.id]);
  assert.deepEqual(groups[1].visualIds, [otherTurn.id]);
  assert.deepEqual(splitVisualizations(marker, false, groups[1].visualIds), [
    { type: "visualization", id: visual.id },
  ]);
});
test("fork/reopen hydration keeps visual identity and resets transcript ownership", () => {
  const select = createChatGroupSelector();
  const original = select(historyEntries([savedVisual()]));
  assert.deepEqual(select([]), []);
  const forkMessage = {
    ...savedVisual(),
    sessionId: "fork",
    _id: `fork:visual:${visual.id}`,
  };
  const fork = select(historyEntries([forkMessage]));
  assert.equal(fork.length, 1);
  assert.notEqual(fork[0], original[0]);
  assert.equal(
    fork[0].entries[0].kind === "visual" && fork[0].entries[0].visual.id,
    visual.id,
  );
});
