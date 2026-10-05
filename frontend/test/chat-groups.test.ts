import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatGroupSelector } from "../lib/chat-groups.ts";
import { applyChatEvent, type Entry } from "../lib/chat.ts";
import type { DomainEvent } from "../../shared/contracts.ts";

test("a streaming update keeps historical group references and updates its own group", () => {
  const select = createChatGroupSelector();
  const entries: Entry[] = [
    { kind: "message", id: "u1", role: "user", text: "First" },
    {
      kind: "message",
      id: "a1",
      role: "assistant",
      turnId: "t1",
      text: "Saved",
      final: true,
    },
    { kind: "message", id: "u2", role: "user", text: "Second" },
    { kind: "thinking", id: "r2", turnId: "t2", text: "Considering" },
    {
      kind: "message",
      id: "a2",
      role: "assistant",
      turnId: "t2",
      itemId: "live",
      text: "Hel",
      final: false,
    },
  ];
  const before = select(entries);
  const next = applyChatEvent(entries, {
    type: "message.delta",
    turnId: "t2",
    itemId: "live",
    data: { delta: "lo" },
  } as unknown as DomainEvent);
  const after = select(next);
  for (let i = 0; i < 3; i++) assert.equal(after[i], before[i]);
  assert.notEqual(after[3], before[3]);
  assert.equal(after[3].entries[0], before[3].entries[0]);
  assert.equal(
    after[3].entries[1].kind === "message" && after[3].entries[1].text,
    "Hello",
  );
  assert.equal(
    before[3].entries[1].kind === "message" && before[3].entries[1].text,
    "Hel",
  );
  assert.equal(select([...next]), after);
});

test("grouping preserves commands, helper blocks, resolved approvals, and turn boundaries", () => {
  const select = createChatGroupSelector();
  const entries: Entry[] = [
    {
      kind: "message",
      id: "u",
      role: "user",
      text: "/goal Report",
      command: { method: "thread/goal/set", params: {}, state: "running" },
    },
    { kind: "thinking", id: "r", turnId: "t", text: "Thinking" },
    { kind: "item", id: "tool", turnId: "t", item: { type: "functionCall" } },
    { kind: "agents", id: "agents:t", turnId: "t", threadIds: ["helper"] },
    {
      kind: "approval",
      id: "approval:r",
      turnId: "t",
      record: {
        requestId: "r",
        turnId: "t",
        outcome: "answered",
        items: [],
      },
    },
    {
      kind: "message",
      id: "a",
      role: "assistant",
      turnId: "t",
      text: "Answer",
      final: true,
    },
    {
      kind: "message",
      id: "follow",
      role: "user",
      text: "Follow up",
      steer: true,
    },
    {
      kind: "message",
      id: "a2",
      role: "assistant",
      turnId: "t",
      text: "More",
      final: true,
    },
  ];
  const groups = select(entries);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].user, entries[0]);
  assert.deepEqual(
    groups[1].entries.map((entry) => entry.kind),
    ["thinking", "agents", "approval", "message"],
  );
  assert.equal(groups[2].user, entries[6]);
  assert.equal(groups[3].turnId, "t");
  assert.equal(groups[3].entries[0], entries[7]);
  assert.equal(
    select([...entries, { kind: "item", id: "ignored", item: {} }]),
    groups,
  );
});

test("provider replay shadows stay hidden and become visible only when they diverge", () => {
  const select = createChatGroupSelector();
  const final: Entry = {
    kind: "message",
    id: "final",
    role: "assistant",
    turnId: "t",
    text: "Hello there",
    final: true,
  };
  const shadow: Entry = {
    kind: "message",
    id: "shadow",
    role: "assistant",
    turnId: "t",
    text: "Hello",
    final: false,
  };
  const before = select([final]);
  assert.equal(select([final, shadow]), before);
  const after = select([final, { ...shadow, text: "Hello again" }]);
  assert.equal(after[0].entries.length, 2);
});

test("reset releases previous groups and matching IDs cannot resurrect another chat's content", () => {
  const select = createChatGroupSelector();
  const old: Entry = {
    kind: "message",
    id: "same",
    role: "assistant",
    turnId: "t",
    text: "Chat A",
    final: true,
  };
  const before = select([old]);
  assert.deepEqual(select([]), []);
  const next: Entry = { ...old, text: "Chat B" };
  const after = select([next]);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[0].entries[0], next);
});
