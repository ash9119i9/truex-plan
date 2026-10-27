import assert from "node:assert/strict";
import { test } from "node:test";
import {
  networkDetail,
  networkOutcome,
  networkTitle,
  parseNetworkBlock,
} from "../lib/tenant-network.ts";
import {
  applyStreamEvent,
  liveReply,
  parseMessage,
  withNetworkDecision,
  type ChatThread,
} from "../lib/tenant-chat.ts";

const site = {
  host: "docs.example.com",
  method: "CONNECT",
  kind: "unlisted",
  critical: false,
  grant: "chat",
};
const write = {
  host: "api.github.com",
  method: "DELETE",
  kind: "write",
  critical: true,
  grant: "once",
  connector: { name: "github", displayName: "GitHub", account: "octo" },
};

test("parses a blocked request and drops malformed ones", () => {
  assert.deepEqual(parseNetworkBlock(site), {
    ...site,
    connector: null,
    decision: null,
  });
  assert.equal(parseNetworkBlock({ ...site, host: "<b>x</b>" }), null);
  assert.equal(parseNetworkBlock({ ...site, method: "get" }), null);
  assert.equal(parseNetworkBlock({ ...site, kind: "other" }), null);
  assert.equal(parseNetworkBlock({ ...site, grant: "always" }), null);
  assert.equal(
    parseNetworkBlock({ ...site, decision: "allow_for_chat" })?.decision,
    "allow_for_chat",
  );
});

test("cards say what happened in plain words", () => {
  const unlisted = parseNetworkBlock(site)!;
  assert.equal(
    networkTitle(unlisted),
    "Blocked a connection to docs.example.com",
  );
  assert.match(networkDetail(unlisted), /nothing was sent/);
  const critical = parseNetworkBlock(write)!;
  assert.equal(networkTitle(critical), "Blocked an important change to GitHub");
  assert.match(networkDetail(critical), /DELETE to api\.github\.com as octo/);
  assert.match(
    networkDetail(
      parseNetworkBlock({ ...site, kind: "refused", grant: "none" })!,
    ),
    /never allowed/,
  );
  assert.equal(networkOutcome("allow_once"), "Allowed for the next reply");
});

test("a saved card message parses; a tool message with nothing readable is dropped", () => {
  const base = {
    id: "64b7f0c2a1b2c3d4e5f60b01",
    seq: 3,
    runId: "64b7f0c2a1b2c3d4e5f60b02",
    role: "tool",
    text: "",
    state: "complete",
    createdAt: "2026-10-24T00:00:00.000Z",
  };
  assert.equal(
    parseMessage({ ...base, network: write })?.network?.kind,
    "write",
  );
  assert.equal(parseMessage({ ...base, network: { host: "x" } }), null);
});

test("a live block is placed once per site and method", () => {
  let reply = liveReply("64b7f0c2a1b2c3d4e5f60b02", 0);
  reply = applyStreamEvent(reply, { type: "network", data: site });
  reply = applyStreamEvent(reply, {
    type: "network",
    data: { ...site, method: "GET" },
  });
  reply = applyStreamEvent(reply, { type: "network", data: write });
  reply = applyStreamEvent(reply, { type: "network", data: { host: "bad" } });
  assert.deepEqual(
    reply.items.map((i) =>
      i.type === "network" ? [i.host, i.method] : i.type,
    ),
    [
      ["docs.example.com", "CONNECT"],
      ["api.github.com", "DELETE"],
    ],
  );
  assert.equal(reply.phase, "streaming");
});

test("an answer settles its own card only, once", () => {
  const message = parseMessage({
    id: "64b7f0c2a1b2c3d4e5f60b01",
    seq: 3,
    runId: "64b7f0c2a1b2c3d4e5f60b02",
    role: "tool",
    text: "",
    state: "complete",
    network: site,
    createdAt: "2026-10-24T00:00:00.000Z",
  })!;
  const thread = { messages: [message] } as unknown as ChatThread;
  const answered = withNetworkDecision(thread, message.id, "allow_for_chat");
  assert.equal(answered.messages[0]!.network?.decision, "allow_for_chat");
  assert.equal(
    withNetworkDecision(answered, message.id, "keep_blocked"),
    answered,
  );
  assert.equal(withNetworkDecision(thread, "other", "allow_once"), thread);
});
