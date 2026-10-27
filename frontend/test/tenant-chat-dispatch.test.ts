import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  canSendMessage,
  messageIds,
  readOnlyNote,
} from "../lib/tenant-chat.ts";
import {
  pendingAttachments,
  previewSeeds,
  uploadIds,
  type DraftFile,
} from "../lib/tenant-uploads.ts";

// Runs the chat page's real send handlers (`send`, `sendFollowUp` and the
// `dispatch` they share) against recorded state and a stubbed platform. No
// browser, React or network is involved.
const source = readFileSync(
  new URL("../components/tenant/tenant-chat.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "tenant-chat.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const handlers = new Set(["send", "sendFollowUp", "dispatch"]);
const parts: string[] = [];
(function collect(node: ts.Node) {
  if (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((d) =>
      handlers.has(d.name.getText(ast)),
    )
  )
    parts.push(node.getText(ast));
  ts.forEachChild(node, collect);
})(ast);
assert.equal(parts.length, handlers.size, "every handler was found");
const script = ts.transpileModule(
  `${parts.join("\n")}\nglobalThis.handlers = { send, sendFollowUp, dispatch };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const CHAT = { id: "chat-1", status: "active", activeRunId: null };
const FILE: DraftFile = {
  key: "file-1",
  name: "spec.pdf",
  size: 10,
  state: "ready",
  uploadId: "a".repeat(24),
};

function harness(fail = false) {
  const sent: unknown[][] = [];
  const state: Record<string, any> = {
    drafts: { "chat-1": "My half-typed question" },
    draftFiles: { "chat-1": [FILE] },
    fileErrors: {},
    failure: null,
  };
  const setter =
    (name: string) =>
    (value: unknown): void => {
      state[name] = typeof value === "function" ? value(state[name]) : value;
    };
  const context: Record<string, any> = {
    openId: "chat-1",
    openThread: { chat: CHAT },
    selected: null,
    sendingRef: { current: false },
    openRef: { current: "chat-1" },
    ids: messageIds(() => `cm-${sent.length + 1}`),
    get draftFiles() {
      return state.draftFiles;
    },
    get drafts() {
      return state.drafts;
    },
    canSendMessage,
    readOnlyNote,
    uploadIds,
    pendingAttachments,
    previewSeeds,
    sendMessage: async (...args: unknown[]) => {
      sent.push(args);
      if (fail) throw new Error("offline");
      return {
        kind: "send",
        receipt: {
          chat: CHAT,
          run: { id: "run-2" },
          message: { attachments: [] },
        },
      };
    },
    startChat: async () => assert.fail("no new chat is started"),
    connectionRequired: () => null,
    sendFailure: () => ({ message: "Not sent", reload: false }),
    withChat: (list: unknown) => list,
    withReceipt: (thread: unknown) => thread,
    withSteer: (thread: unknown) => thread,
    withLiveSteer: (reply: unknown) => reply,
    dropSteer: (reply: unknown) => reply,
    liveReply: (runId: string) => ({ runId }),
    fetchChatFiles: async () => [],
    addFiles() {},
    seedFileContent() {},
    warnFailure() {},
    navigate() {},
    load: async () => {},
  };
  for (const name of [
    "Drafts",
    "DraftFiles",
    "FileErrors",
    "Failure",
    "Sending",
    "ConnectCard",
    "Live",
    "Pending",
    "Chats",
    "Thread",
    "Opened",
  ])
    context[`set${name}`] = setter(name[0]!.toLowerCase() + name.slice(1));
  vm.createContext(context);
  vm.runInContext(script, context);
  return { ...context.handlers, state, sent };
}

const ROW = { slot: 2, intent: "verify", text: "Check the authorisations" };

test("a Follow Up row sends only its text and keeps the draft", async () => {
  const page = harness();
  assert.equal(await page.sendFollowUp("run-1", ROW), true);
  assert.equal(page.sent.length, 1);
  // Values made inside the harness are copied into this realm to compare.
  const [, text, , attachments, followUp] = page.sent[0] as [
    unknown,
    string,
    unknown,
    string[],
    object,
  ];
  assert.equal(text, ROW.text);
  assert.deepEqual([...attachments], []);
  assert.deepEqual({ ...followUp }, { fromRunId: "run-1", slot: 2 });
  assert.equal(page.state.drafts["chat-1"], "My half-typed question");
  assert.deepEqual(page.state.draftFiles["chat-1"], [FILE]);
});

test("a failed Follow Up row keeps the draft instead of its own text", async () => {
  const page = harness(true);
  assert.equal(await page.sendFollowUp("run-1", ROW), false);
  assert.equal(page.state.drafts["chat-1"], "My half-typed question");
  assert.deepEqual(page.state.draftFiles["chat-1"], [FILE]);
  assert.equal(page.state.failure?.failure.message, "Not sent");
});

test("a failed Follow Up row fills an empty composer with its text", async () => {
  const page = harness(true);
  page.state.drafts = {};
  page.state.draftFiles = {};
  assert.equal(await page.sendFollowUp("run-1", ROW), false);
  assert.equal(page.state.drafts["chat-1"], ROW.text);
});

test("a composer send still sends and clears the draft and its files", async () => {
  const page = harness();
  page.send();
  await new Promise((resolve) => setImmediate(resolve));
  const [, text, , attachments, followUp] = page.sent[0] as [
    unknown,
    string,
    unknown,
    string[],
    unknown,
  ];
  assert.equal(text, "My half-typed question");
  assert.deepEqual([...attachments], [FILE.uploadId]);
  assert.equal(followUp, undefined);
  assert.equal(page.state.drafts["chat-1"], undefined);
  assert.equal(page.state.draftFiles["chat-1"], undefined);
});
