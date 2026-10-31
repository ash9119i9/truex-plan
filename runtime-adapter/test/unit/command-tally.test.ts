import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommandTally } from "../../src/runtime/command-tally";

// The reply's command counts behind COMMAND_LIMIT (chat.ts countCommand).
describe("command tally", () => {
  const ok = { status: "completed", exitCode: 0 };
  const limits = { maxCommands: 5, maxFailedCommands: 3 };

  test("a repeated item/completed for one command counts once", () => {
    const tally = new CommandTally();
    const failed = { status: "completed", exitCode: 1 };
    assert.equal(tally.add(":c1", failed), true);
    assert.equal(tally.add(":c1", failed), false);
    assert.deepEqual([tally.commands, tally.failed], [1, 1]);
  });

  test("the same item id on two threads is two commands", () => {
    const tally = new CommandTally();
    tally.add(":c1", ok);
    tally.add("helper-thread:c1", ok);
    assert.equal(tally.commands, 2);
  });

  test("a command with no id is always counted", () => {
    const tally = new CommandTally();
    tally.add("", ok);
    tally.add("", ok);
    assert.equal(tally.commands, 2);
  });

  test("failed, declined and non-zero exits fail; a clean exit doesn't", () => {
    const tally = new CommandTally();
    tally.add("a", { status: "completed", exitCode: 0 });
    tally.add("b", { status: "completed", exitCode: 2 });
    tally.add("c", { status: "failed" });
    tally.add("d", { status: "declined" });
    assert.deepEqual([tally.commands, tally.failed], [4, 3]);
  });

  test("over is reached at either limit, not before", () => {
    const failing = new CommandTally();
    for (const key of ["a", "b"]) failing.add(key, { status: "failed" });
    assert.equal(failing.over(limits), false);
    failing.add("c", { status: "failed" });
    assert.equal(failing.over(limits), true);
    const busy = new CommandTally();
    for (const key of ["a", "b", "c", "d"]) busy.add(key, ok);
    assert.equal(busy.over(limits), false);
    busy.add("e", ok);
    assert.equal(busy.over(limits), true);
  });
});
