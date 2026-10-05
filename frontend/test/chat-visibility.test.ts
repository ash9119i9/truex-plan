import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleEntries, type Entry } from "../lib/chat.ts";

function legacy(entries: Entry[]) {
  return entries.filter(
    (entry) =>
      entry.kind !== "message" ||
      entry.role !== "assistant" ||
      entry.final ||
      !entry.turnId ||
      !entry.text.trim() ||
      !entries.some(
        (other) =>
          other.kind === "message" &&
          other.role === "assistant" &&
          other.final &&
          other.turnId === entry.turnId &&
          other.text.trim().startsWith(entry.text.trim()),
      ),
  );
}

test("visibility retains exact prefix, turn, completion, Unicode and reference semantics", () => {
  let seed = 0x84583;
  const pick = <T>(values: T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  for (let fixture = 0; fixture < 200; fixture++) {
    const entries: Entry[] = Array.from({ length: 80 }, (_, index) => ({
      kind: "message",
      id: `${index}`,
      itemId: `item-${index}`,
      aliases: ["shared-alias"],
      role: pick(["assistant", "user", "system"]),
      turnId: pick([undefined, "", "a", "b", "__proto__"]),
      text: pick([
        "",
        " \t\n",
        " Hello ",
        "Hello again",
        "Hell",
        "Hello divergent",
        "😀",
        "😀界",
        "\ud83d",
        "\u0000",
        "a\u0000b",
        "𐀀",
        "\uffff",
      ]),
      final: pick([undefined, false, true]),
      done: pick([undefined, false, true]),
    }));
    entries.splice(10, 0, {
      kind: "thinking",
      id: "thinking",
      text: "Hello",
      turnId: "a",
    });
    const before = structuredClone(entries);
    const expected = legacy(entries);
    const actual = visibleEntries(entries);
    assert.deepEqual(actual, expected);
    actual.forEach((entry, index) => assert.equal(entry, expected[index]));
    assert.deepEqual(entries, before);
  }
});

test("interrupted histories do not rescan the full transcript for every answer", () => {
  let visits = 0;
  const entries: Entry[] = Array.from({ length: 400 }, (_, index) => {
    const entry: Entry = {
      kind: "message",
      id: `${index}`,
      role: "assistant",
      text: "Interrupted",
      turnId: `turn-${index}`,
      final: false,
      done: true,
    };
    return new Proxy(entry, {
      get(target, key, receiver) {
        if (key === "kind") visits++;
        return Reflect.get(target, key, receiver);
      },
    });
  });
  assert.equal(visibleEntries(entries).length, entries.length);
  assert.ok(
    visits <= entries.length * 4,
    `Expected linear entry visits, saw ${visits}`,
  );
});

test("many finalized answers in one turn do not cause repeated linear prefix searches", (t) => {
  let comparisons = 0;
  const original = String.prototype.startsWith;
  t.mock.method(
    String.prototype,
    "startsWith",
    function (this: string, prefix: string, position?: number) {
      comparisons++;
      return original.call(this, prefix, position);
    },
  );
  const entries: Entry[] = Array.from({ length: 800 }, (_, index) => ({
    kind: "message",
    id: `${index}`,
    role: "assistant",
    turnId: "same",
    text: index < 400 ? `z-partial-${index}` : `a-final-${index}`,
    final: index >= 400,
  }));
  assert.equal(visibleEntries(entries).length, entries.length);
  assert.ok(
    comparisons <= entries.length,
    `Expected bounded prefix checks, saw ${comparisons}`,
  );
});
