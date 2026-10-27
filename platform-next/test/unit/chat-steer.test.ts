import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { textHashOf, type SteerDoc } from "../../src/modules/chats/chat";
import {
  plannedMessages,
  type SettleItem,
} from "../../src/modules/chats/chat-store";

const steer = (clientMessageId: string, text: string): SteerDoc => ({
  clientMessageId,
  text,
  textHash: textHashOf(text),
  createdAt: new Date(0),
});
const reply = (itemId: string, text: string, completed = true): SettleItem => ({
  type: "reply",
  itemId,
  text,
  completed,
});
const input = (clientMessageId: string): SettleItem => ({
  type: "input",
  clientMessageId,
});
const shape = (planned: ReturnType<typeof plannedMessages>) =>
  planned.map((m) => [m.role, m.text, m.state]);

describe("settling a steered run", () => {
  test("without steers every non-empty reply takes the run's outcome", () => {
    const planned = plannedMessages(
      {},
      {
        status: "stopped",
        items: [reply("a", "One."), reply("b", "  "), reply("c", "Two", false)],
      },
    );
    assert.deepEqual(shape(planned), [
      ["assistant", "One.", "stopped"],
      ["assistant", "Two", "stopped"],
    ]);
    assert.equal(planned[0]?.runtimeItemId, "a");
  });

  test("a reply cut by a steer is interrupted; the steer sits where it entered", () => {
    const planned = plannedMessages(
      { steers: [steer("s1", "be brief")] },
      {
        status: "completed",
        items: [
          reply("a", "Working on", false),
          input("s1"),
          reply("b", "Ok."),
        ],
      },
    );
    assert.deepEqual(shape(planned), [
      ["assistant", "Working on", "interrupted"],
      ["user", "be brief", "complete"],
      ["assistant", "Ok.", "complete"],
    ]);
    assert.equal(planned[1]?.clientMessageId, "s1");
    assert.equal(planned[1]?.textHash, textHashOf("be brief"));
    assert.equal(planned[1]?.runtimeItemId, undefined);
  });

  test("a finished reply before a steer stays complete; the last ones take the outcome", () => {
    const planned = plannedMessages(
      { steers: [steer("s1", "more"), steer("s2", "and more")] },
      {
        status: "stopped",
        items: [
          reply("a", "Done."),
          input("s1"),
          input("s2"),
          reply("b", "Partial", false),
        ],
      },
    );
    assert.deepEqual(shape(planned), [
      ["assistant", "Done.", "complete"],
      ["user", "more", "complete"],
      ["user", "and more", "complete"],
      ["assistant", "Partial", "stopped"],
    ]);
  });

  test("steers the runtime never used are saved last as not sent, in order", () => {
    const planned = plannedMessages(
      {
        steers: [
          steer("s1", "first"),
          steer("s2", "second"),
          steer("s3", "third"),
        ],
      },
      { status: "stopped", items: [reply("a", "Hi", false), input("s2")] },
    );
    assert.deepEqual(shape(planned), [
      ["assistant", "Hi", "interrupted"],
      ["user", "second", "complete"],
      ["user", "first", "not_sent"],
      ["user", "third", "not_sent"],
    ]);
  });

  test("a failed run with no items saves its steers as not sent", () => {
    const planned = plannedMessages(
      { steers: [steer("s1", "first")] },
      { status: "failed", items: [] },
    );
    assert.deepEqual(shape(planned), [["user", "first", "not_sent"]]);
  });

  test("an input naming no steer, or repeated, is ignored and reported", () => {
    const unknown: string[] = [];
    const planned = plannedMessages(
      { steers: [steer("s1", "first")] },
      {
        status: "completed",
        items: [input("ghost"), input("s1"), input("s1"), reply("a", "Ok.")],
      },
      (id) => unknown.push(id),
    );
    assert.deepEqual(shape(planned), [
      ["user", "first", "complete"],
      ["assistant", "Ok.", "complete"],
    ]);
    assert.deepEqual(unknown, ["ghost", "s1"]);
  });

  test("tool calls are saved in order as summaries; one still running is failed", () => {
    const planned = plannedMessages(
      {},
      {
        status: "stopped",
        items: [
          reply("a", "Checking."),
          {
            type: "tool",
            itemId: "t1",
            connector: "github",
            tool: "list_issues",
            status: "completed",
            durationMs: 900,
          },
          {
            type: "tool",
            itemId: "t2",
            connector: "github",
            tool: "get_issue",
            status: "inProgress",
          },
        ],
      },
    );
    assert.deepEqual(shape(planned), [
      ["assistant", "Checking.", "stopped"],
      ["tool", "", "complete"],
      ["tool", "", "failed"],
    ]);
    assert.deepEqual(
      planned.map((m) => [m.runtimeItemId, m.tool]),
      [
        ["a", undefined],
        [
          "t1",
          {
            connector: "github",
            name: "list_issues",
            status: "completed",
            durationMs: 900,
          },
        ],
        [
          "t2",
          {
            connector: "github",
            name: "get_issue",
            status: "failed",
            errorCode: "UNKNOWN",
          },
        ],
      ],
    );
  });
});

describe("plannedMessages: coding activity", () => {
  test("commands and file changes become tool messages; unfinished ones are saved failed", () => {
    const planned = plannedMessages(
      { steers: [] },
      {
        status: "stopped",
        items: [
          {
            type: "command",
            itemId: "c1",
            command: "npm test",
            status: "completed",
            exitCode: 0,
            output: "x".repeat(5_000),
            outputTruncated: false,
            approval: "allow",
          },
          {
            type: "file_change",
            itemId: "f1",
            files: [{ path: "a.txt", kind: "add" }],
            status: "inProgress",
          },
        ],
      },
    );
    assert.equal(planned.length, 2);
    const [command, change] = planned;
    assert.equal(command!.role, "tool");
    assert.equal(command!.runtimeItemId, "c1");
    assert.equal(command!.activity?.kind, "command");
    if (command!.activity?.kind !== "command") return;
    assert.equal(command!.activity.output.length, 4_000);
    assert.equal(command!.activity.outputTruncated, true);
    assert.equal(command!.activity.approval, "allow");
    assert.equal(change!.state, "failed");
    assert.deepEqual(change!.activity, {
      kind: "file_change",
      files: [{ path: "a.txt", kind: "add" }],
      status: "failed",
    });
  });
});
