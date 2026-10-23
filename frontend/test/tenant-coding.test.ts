import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyStreamEvent,
  liveReply,
  parseMessage,
  pendingApprovalForItem,
} from "../lib/tenant-chat.ts";
import { parseApprovalEvent } from "../lib/tenant-connectors.ts";
import {
  activityLabel,
  allowForChatHint,
  codingCardTitle,
  MAX_OUTPUT_CHARS,
  parseActivity,
  writingNote,
  type Activity,
} from "../lib/tenant-coding.ts";

type FileChange = Extract<Activity, { type: "file_change" }>;

// Commands and file changes in a chat's workspace: wire parsing, the live
// reply reducer and plain-word labels.

const commandCard = {
  approvalId: "ap_c1",
  itemId: "call_c1",
  kind: "command",
  connector: "@workspace",
  tool: "command",
  params: [
    { name: "command", value: "npm test" },
    { name: "cwd", value: "." },
  ],
  allowForChat: true,
  scope: "a".repeat(64),
  status: "pending",
  expiresAt: "2026-10-21T10:00:00.000Z",
};

test("a coding approval from the workspace parses with its kind and allow flag", () => {
  const event = parseApprovalEvent(commandCard);
  assert.equal(event?.kind, "command");
  assert.equal(event?.connector, "@workspace");
  assert.equal(event?.allowForChat, true);
  // A push card offers no Allow for this chat.
  assert.equal(
    parseApprovalEvent({ ...commandCard, tool: "push", allowForChat: false })
      ?.allowForChat,
    false,
  );
  // A long command is kept whole on its card (other values are cut at 500).
  const long = "x".repeat(3_000);
  assert.equal(
    parseApprovalEvent({
      ...commandCard,
      params: [{ name: "command", value: long }],
    })?.params[0].value.length,
    3_000,
  );
});

test("a coding approval that does not come from the workspace is dropped", () => {
  assert.equal(
    parseApprovalEvent({ ...commandCard, connector: "github" }),
    null,
  );
  // A connector approval is unaffected.
  assert.equal(
    parseApprovalEvent({
      ...commandCard,
      kind: undefined,
      connector: "github",
      tool: "create_branch",
    })?.kind,
    "mcp",
  );
});

test("a file change approval is not a coding card (edits never ask)", () => {
  const event = parseApprovalEvent({
    ...commandCard,
    kind: "file_change",
    tool: "file_change",
    params: [{ name: "add", value: "src/a.py" }],
  });
  // Read as a connector card, whose "@workspace" slug is refused.
  assert.equal(event, null);
});

test("activity events place a command, stream its output and settle it", () => {
  let reply = liveReply("run1", 0);
  reply = applyStreamEvent(reply, {
    type: "activity",
    data: {
      type: "command",
      itemId: "call_c1",
      command: "npm test",
      status: "inProgress",
      output: "",
      outputTruncated: false,
    },
  });
  reply = applyStreamEvent(reply, { type: "approval", data: commandCard });
  assert.equal(pendingApprovalForItem(reply, "call_c1")?.kind, "command");
  reply = applyStreamEvent(reply, {
    type: "output",
    data: { itemId: "call_c1", text: "ok 1\n" },
  });
  reply = applyStreamEvent(reply, {
    type: "activity",
    data: {
      type: "command",
      itemId: "call_c1",
      command: "npm test",
      status: "completed",
      exitCode: 0,
      output: "",
      outputTruncated: false,
      approval: "allow",
    },
  });
  const [item] = reply.items;
  assert.equal(item.type, "command");
  if (item.type !== "command") return;
  assert.equal(item.status, "completed");
  // Output streamed earlier is kept when the completion carries none.
  assert.equal(item.output, "ok 1\n");
  // A late start never reopens a finished command.
  const again = applyStreamEvent(reply, {
    type: "activity",
    data: { ...item, status: "inProgress" },
  });
  assert.equal(again, reply);
});

test("streamed output is capped", () => {
  let reply = applyStreamEvent(liveReply("run1", 0), {
    type: "activity",
    data: {
      type: "command",
      itemId: "c",
      command: "yes",
      status: "inProgress",
      output: "",
    },
  });
  reply = applyStreamEvent(reply, {
    type: "output",
    data: { itemId: "c", text: "y".repeat(MAX_OUTPUT_CHARS + 10) },
  });
  const [item] = reply.items;
  assert.ok(item.type === "command" && item.output.length === MAX_OUTPUT_CHARS);
  assert.ok(item.type === "command" && item.outputTruncated);
});

test("a snapshot restores commands and file changes", () => {
  const reply = applyStreamEvent(liveReply("run1", 0), {
    type: "snapshot",
    data: {
      runId: "run1",
      phase: "streaming",
      items: [
        {
          type: "file_change",
          itemId: "f1",
          files: [
            { path: "a.txt", kind: "add" },
            { path: "b.txt", kind: "rename" },
          ],
          status: "completed",
        },
      ],
      approvals: [],
    },
  });
  assert.deepEqual(reply.items, [
    {
      type: "file_change",
      itemId: "f1",
      files: [{ path: "a.txt", kind: "add" }],
      status: "completed",
      approval: null,
    },
  ]);
});

test("a saved activity message parses; one with neither tool nor activity is dropped", () => {
  const base = {
    id: "65f000000000000000000001",
    seq: 3,
    runId: "65f000000000000000000002",
    role: "tool",
    text: "",
    state: "complete",
    createdAt: "2026-10-21T10:00:00.000Z",
  };
  const saved = parseMessage({
    ...base,
    activity: {
      kind: "command",
      command: "pytest",
      status: "failed",
      exitCode: 1,
      output: "1 failed",
      outputTruncated: false,
      approval: "allow_for_chat",
    },
  });
  assert.equal(saved?.activity?.type, "command");
  assert.equal(saved?.activity?.status, "failed");
  assert.equal(parseMessage(base), null);
});

test("labels are plain words", () => {
  const cmd = parseActivity({
    type: "command",
    itemId: "c",
    command: "pytest",
    status: "failed",
    exitCode: 2,
  })!;
  assert.equal(activityLabel(cmd), "Command failed (exit 2)");
  assert.equal(
    activityLabel({ ...cmd, status: "declined" }),
    "Command not run",
  );
  const edit = parseActivity({
    type: "file_change",
    itemId: "f",
    files: [{ path: "src/app.py", kind: "update" }],
    status: "completed",
  }) as FileChange;
  assert.equal(activityLabel(edit), "Edited src/app.py");
  const created = {
    ...edit,
    files: [{ path: "guide.md", kind: "add" as const }],
  };
  assert.equal(activityLabel(created), "Created guide.md");
  assert.equal(
    activityLabel({ ...created, status: "inProgress" }),
    "Creating guide.md",
  );
  assert.equal(
    activityLabel({ ...created, status: "declined" }),
    "Creation of guide.md not made",
  );
  assert.equal(
    activityLabel({
      ...edit,
      files: [
        { path: "a.py", kind: "delete" },
        { path: "b.py", kind: "delete" },
      ],
    }),
    "Deleted 2 files",
  );
  assert.equal(
    activityLabel({
      ...edit,
      files: [
        { path: "a.py", kind: "add" },
        { path: "b.py", kind: "update" },
      ],
    }),
    "Edited 2 files",
  );
  assert.equal(
    activityLabel({
      ...edit,
      status: "failed",
      files: [{ path: "x", kind: "delete" }],
    }),
    "Couldn't delete x",
  );
  assert.equal(codingCardTitle("push"), "The assistant wants to push code");
  assert.equal(
    codingCardTitle("command"),
    "The assistant wants to run a command",
  );
  assert.equal(allowForChatHint("push"), null);
  assert.match(String(allowForChatHint("command")), /only this exact command/);
});

test("a file change being written shows as progress until its activity replaces it", () => {
  const files = [{ path: "guide.md", kind: "add" }];
  let reply = liveReply("run1");
  const progress = (data: Record<string, unknown>) =>
    (reply = applyStreamEvent(reply, { type: "progress", data }));
  progress({ itemId: "call_f1", files, lines: 12 });
  progress({ itemId: "call_f1", files, lines: 120 });
  assert.equal(reply.items.length, 1);
  const writing = reply.items[0] as FileChange;
  assert.equal(writing.writtenLines, 120);
  assert.equal(activityLabel(writing), "Creating guide.md");
  assert.equal(writingNote(writing), "120 lines");
  assert.equal(reply.phase, "streaming");
  // Malformed progress is ignored.
  progress({ itemId: "call_f1", files: [], lines: 130 });
  progress({ itemId: "call_f1", files, lines: -2 });
  assert.equal((reply.items[0] as FileChange).writtenLines, 120);
  // The file change itself takes the row's place.
  reply = applyStreamEvent(reply, {
    type: "activity",
    data: {
      type: "file_change",
      itemId: "call_f1",
      files,
      status: "inProgress",
    },
  });
  assert.equal(reply.items.length, 1);
  assert.equal((reply.items[0] as FileChange).writtenLines, undefined);
  assert.equal(writingNote(reply.items[0] as Activity), null);
  // Late progress and an end never touch a real activity.
  progress({ itemId: "call_f1", files, lines: 121 });
  progress({ itemId: "call_f1", ended: true });
  assert.equal(reply.items.length, 1);
  assert.equal((reply.items[0] as FileChange).writtenLines, undefined);
  // A patch that never became a change disappears when it ends.
  progress({ itemId: "call_f2", files, lines: 1 });
  assert.equal(writingNote(reply.items[1] as Activity), "1 line");
  progress({ itemId: "call_f2", ended: true });
  assert.deepEqual(
    reply.items.map((i) => ("itemId" in i ? i.itemId : null)),
    ["call_f1"],
  );
});

test("a snapshot restores file changes still being written after its items", () => {
  const reply = applyStreamEvent(liveReply("run1"), {
    type: "snapshot",
    data: {
      runId: "run1",
      phase: "streaming",
      items: [
        {
          type: "reply",
          itemId: "m1",
          text: "Writing it now.",
          completed: true,
        },
      ],
      approvals: [],
      writing: [
        { itemId: "call_f1", files: [{ path: "a.md", kind: "add" }], lines: 7 },
        { itemId: "bad", files: [], lines: 1 },
      ],
    },
  });
  assert.deepEqual(
    reply.items.map((i) => i.type),
    ["reply", "file_change"],
  );
  assert.equal((reply.items[1] as FileChange).writtenLines, 7);
});
