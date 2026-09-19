import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChatEvent,
  historyEntries,
  visibleEntries,
  type Entry,
} from "../lib/chat.ts";
import type { DomainEvent, Message } from "../../shared/contracts.ts";

const event = (
  type: DomainEvent["type"],
  data: Record<string, unknown>,
  itemId = "answer",
  turnId = "turn",
) => ({ type, data, itemId, turnId }) as DomainEvent;
const history = (extra = {}) =>
  historyEntries([
    {
      _id: "saved",
      role: "assistant",
      text: "Hello",
      turnId: "turn",
      messageIndex: 0,
      ...extra,
    } as Message,
  ]);

test("history, replay, and a snapshot render one authoritative reply", () => {
  let entries = history({ itemId: "stored", runtimeItemId: "runtime" });
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: "Hello", messageIndex: 0 }, "runtime"),
  );
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello", messageIndex: 0 }, "runtime"),
  );
  entries = applyChatEvent(
    entries,
    event("snapshot", {
      state: { kind: "idle" },
      messages: [
        {
          id: "runtime",
          turnId: "turn",
          text: "Hello",
          messageIndex: 0,
          final: true,
        },
      ],
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind === "message" && entries[0].text, "Hello");
});
test("a final adopts its stream even when runtime changes the ID", () => {
  let entries = applyChatEvent([], event("message.delta", { delta: "Hel" }));
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello", messageIndex: 0 }, "final-id"),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind === "message" && entries[0].text, "Hello");
});
test("different messages and turns are not collapsed by identical text", () => {
  let entries = history({ itemId: "first" });
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello", messageIndex: 1 }, "second"),
  );
  entries = applyChatEvent(
    entries,
    event(
      "message.final",
      { text: "Hello", messageIndex: 0 },
      "first",
      "other-turn",
    ),
  );
  assert.equal(entries.length, 3);
});
test("late reasoning is placed before the saved answer and updated in place", () => {
  let entries = applyChatEvent(
    history(),
    event("reasoning.delta", { delta: "Consider this." }, "reason"),
  );
  entries = applyChatEvent(
    entries,
    event(
      "item.completed",
      {
        item: { id: "reason", type: "reasoning", summary: ["Consider this."] },
      },
      "reason",
    ),
  );
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["thinking", "message"],
  );
  assert.equal(
    entries[0].kind === "thinking" && entries[0].text,
    "Consider this.",
  );
});
test("raw reasoning and summary streams never concatenate duplicate content", () => {
  let entries: Entry[] = [];
  for (const method of [
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
  ])
    entries = applyChatEvent(
      entries,
      event("reasoning.delta", { delta: "Consider this.", method }, "reason"),
    );
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].kind === "thinking" && entries[0].text,
    "Consider this.",
  );
});
test("runtime agentMessage items cannot create a second answer row", () => {
  const entries = history();
  assert.deepEqual(
    applyChatEvent(
      entries,
      event("item.completed", {
        item: { id: "answer", type: "agentMessage", text: "Hello" },
      }),
    ),
    entries,
  );
});
test("completing a turn closes only its own partial content", () => {
  let entries = applyChatEvent(
    [],
    event("reasoning.delta", { delta: "First" }, "r1"),
  );
  entries = applyChatEvent(
    entries,
    event("reasoning.delta", { delta: "Second" }, "r2", "other"),
  );
  entries = applyChatEvent(entries, event("turn.completed", {}));
  assert.equal(entries[0].kind === "thinking" && entries[0].done, true);
  assert.equal(entries[1].kind === "thinking" && !!entries[1].done, false);
});

test("provider replay on a second unfinished item stays hidden, including after completion", () => {
  let entries = history({ text: " Hello there", itemId: "final" });
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: "Hello", messageIndex: 1 }, "shadow"),
  );
  assert.equal(visibleEntries(entries).length, 1);
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: " there", messageIndex: 1 }, "shadow"),
  );
  entries = applyChatEvent(entries, event("turn.completed", {}));
  assert.equal(visibleEntries(entries).length, 1);
  // A genuine second completed reply is still retained.
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello there", messageIndex: 1 }, "shadow"),
  );
  assert.equal(visibleEntries(entries).length, 2);
});
test("a partial replay that diverges becomes a separate visible message", () => {
  let entries = history({ text: "Hello there" });
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: "Hello", messageIndex: 1 }, "second"),
  );
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: " again", messageIndex: 1 }, "second"),
  );
  assert.equal(visibleEntries(entries).length, 2);
});
