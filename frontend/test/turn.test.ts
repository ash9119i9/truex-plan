import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { orderTurn, workLabel } from "../lib/turn.ts";
import { component } from "./next-details-runtime.ts";

const { AgentReply, SavedBody, LiveBody, ActivityRow } = component(
  "tenant/chat-transcript.tsx",
);

const msg = (id: string, extra: Record<string, unknown>) => ({
  id,
  runId: "r1",
  seq: 1,
  createdAt: "2026-10-28T10:31:00.000Z",
  state: "complete",
  text: "",
  ...extra,
});
const tool = (id: string) =>
  msg(id, {
    role: "tool",
    tool: {
      connector: "crm",
      name: "find_deals",
      status: "completed",
      durationMs: 1200,
      errorCode: null,
    },
  });

test("a turn's parts go to the spec's slots in order, stable within a slot", () => {
  const parts = [
    { id: "narrate", slot: "tools" },
    { id: "answer-1", slot: "body" },
    { id: "steer", slot: "asks" },
    { id: "call", slot: "tools" },
    { id: "answer-2", slot: "body" },
    { id: "crew", slot: "helpers" },
  ] as const;
  assert.deepEqual(
    orderTurn(parts, (p) => p.slot).map((p) => p.id),
    ["crew", "narrate", "call", "steer", "answer-1", "answer-2"],
  );
});

test("the work fold names what ran", () => {
  assert.equal(workLabel(1, 0), "Used 1 tool");
  assert.equal(workLabel(3, 0), "Used 3 tools");
  assert.equal(workLabel(3, 1), "Using tools");
});

test("a saved reply reads answer after its folded work, under the agent's name", () => {
  const html = renderToStaticMarkup(
    createElement(
      AgentReply,
      { agentName: "Analyst", live: null, time: "10:31" },
      createElement(SavedBody, {
        entries: [
          msg("m1", { role: "assistant", text: "Let me look." }),
          tool("m2"),
          msg("m3", { role: "assistant", text: "Two deals closed." }),
        ],
        connectors: [],
        note: null,
        usage: "",
        failed: false,
        card: null,
      }),
    ),
  );
  assert.match(html, /<article class="cs-msg cs-msg-agent"/);
  assert.match(html, /class="pt-agent-head"/);
  assert.match(html, /class="pt-agent-name">Analyst</);
  assert.match(html, /class="pt-agent-meta num">10:31</);
  assert.match(html, /class="cs-msg-body"/);
  const work = html.indexOf('class="cs-work"');
  const answer = html.indexOf("Two deals closed.");
  assert.ok(work > 0 && answer > work, "the work fold comes before the answer");
  // folded once settled: a closed <details>
  assert.match(html, /<details class="cs-work">/);
  assert.match(html, /Used 1 tool/);
  // the narration lives in the work, not in the answer
  assert.ok(html.indexOf("Let me look.") < answer);
  assert.ok(html.indexOf("Let me look.") > work);
  assert.match(html, /class="pt-answer-body markdown"/);
});

test("a streaming reply is busy, carries the caret and keeps a steer in its asks slot", () => {
  const live = {
    runId: "r1",
    phase: "streaming",
    since: Date.now(),
    items: [
      { type: "reply", itemId: "a", text: "First part", completed: false },
      {
        type: "input",
        clientMessageId: "c1",
        text: "Only Q3 please",
        placed: true,
      },
      { type: "reply", itemId: "b", text: "Q3 only", completed: false },
    ],
    helpers: [],
    approvals: {},
    connectorFailures: [],
    unsaved: [],
    outcome: null,
    saveFailed: false,
  };
  const html = renderToStaticMarkup(
    createElement(
      AgentReply,
      { agentName: "Analyst", live },
      createElement(LiveBody, {
        live,
        run: null,
        connection: "open",
        connectors: [],
        tenantId: "t",
        onReconnect() {},
        onApprove() {},
        approvalBusy: null,
        files: [],
      }),
    ),
  );
  assert.match(
    html,
    /class="cs-msg cs-msg-agent is-streaming"[^>]*aria-busy="true"/,
  );
  const steer = html.indexOf("cs-msg-user is-steer");
  assert.ok(steer > 0);
  assert.ok(steer < html.indexOf("First part"), "asks sit above the answer");
  assert.match(html, /added to this turn/);
  // the caret trails the last answer only (CSS on .is-live's last block)
  assert.equal(
    (html.match(/pt-answer-body markdown is-live/g) ?? []).length,
    1,
  );
  assert.ok(html.indexOf("is-live") < html.indexOf("Q3 only"));
  assert.ok(html.indexOf("is-live") > html.indexOf("First part"));
});

// DESIGN-SPEC 11.7 slot 6: the stopped notice sits with the asks, above the
// answer it cut short, not under it with the receipt.
test("a saved stopped reply shows its notice above the answer", () => {
  const html = renderToStaticMarkup(
    createElement(SavedBody, {
      entries: [
        msg("m1", { role: "assistant", text: "Starting a long answer" }),
      ],
      connectors: [],
      note: "Stopped",
      usage: "",
      failed: false,
      card: null,
    }),
  );
  const notice = html.indexOf(">Stopped<");
  assert.ok(notice > 0, "the notice is shown");
  assert.ok(notice < html.indexOf("Starting a long answer"));
});

test("a live reply that was stopped shows its notice above the answer", () => {
  const live = {
    runId: "r1",
    phase: "settled",
    since: Date.now(),
    items: [
      { type: "reply", itemId: "a", text: "Partial answer", completed: true },
    ],
    helpers: [],
    approvals: {},
    connectorFailures: [],
    unsaved: [],
    outcome: { status: "stopped", error: null },
    saveFailed: false,
  };
  const html = renderToStaticMarkup(
    createElement(LiveBody, {
      live,
      run: null,
      connection: "open",
      connectors: [],
      tenantId: "t",
      onReconnect() {},
      onApprove() {},
      approvalBusy: null,
      files: [],
    }),
  );
  const notice = html.indexOf(">Stopped<");
  assert.ok(notice > 0, "the notice is shown");
  assert.ok(notice < html.indexOf("Partial answer"));
});

// DESIGN-SPEC 12.2: a row is business-safe, a friendly name and status; the
// raw command and its output appear only behind the row's Details toggle.
test("a command row keeps the command and output behind Details", () => {
  const html = renderToStaticMarkup(
    createElement(ActivityRow, {
      live: false,
      activity: {
        type: "command",
        itemId: "c1",
        command: "ls -la",
        status: "failed",
        exitCode: 1,
        durationMs: 40,
        output: "no such file",
        outputTruncated: false,
        approval: null,
      },
    }),
  );
  assert.match(html, /class="ta-name">Command failed \(exit 1\)</);
  const details = html.indexOf('<details class="ta-details">');
  assert.ok(details > 0, "the row has a Details disclosure");
  assert.match(
    html,
    /<summary class="ta-toggle">Details<svg[^>]*class="[^"]*ta-chev/,
  );
  assert.ok(html.indexOf("ls -la") > details, "the command is inside Details");
  assert.ok(html.indexOf("no such file") > details);
  assert.match(html, /class="ta-label">Command</);
  assert.match(html, /class="ta-label">Output</);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
});

test("a declined command is named once and its record names the request, not the outcome", () => {
  const html = renderToStaticMarkup(
    createElement(
      AgentReply,
      { agentName: "Analyst", live: null, time: "10:31" },
      createElement(SavedBody, {
        entries: [
          msg("m1", {
            role: "tool",
            activity: {
              type: "command",
              itemId: "c1",
              command: "git push --force",
              status: "declined",
              exitCode: null,
              durationMs: null,
              output: "",
              outputTruncated: false,
              approval: "deny",
            },
          }),
          msg("m2", { role: "assistant", text: "Not pushing." }),
        ],
        connectors: [],
        note: null,
        usage: "",
        failed: false,
        card: null,
      }),
    ),
  );
  assert.match(html, /class="ta-name">Command not run</);
  assert.match(html, /class="ta-sub">Not allowed</);
  assert.doesNotMatch(html, /Not run</);
  const row = html.slice(
    html.indexOf('class="ta '),
    html.indexOf("</div>", html.indexOf('class="ta ')),
  );
  assert.equal((row.match(/Not allowed/g) ?? []).length, 1);
  assert.match(html, /class="ar-title">Run a command</);
});

test("a fold held on an approval keeps its label: the working line says it", () => {
  const live = {
    runId: "r1",
    phase: "streaming",
    since: 0,
    items: ["a", "b"].map((id) => ({
      type: "tool",
      itemId: id,
      connector: "crm",
      tool: "create_deal",
      status: id === "a" ? "completed" : "inProgress",
      durationMs: id === "a" ? 900 : null,
      errorCode: null,
    })),
    helpers: [],
    approvals: {
      x: {
        approvalId: "x",
        itemId: "b",
        kind: "mcp",
        connector: "crm",
        tool: "create_deal",
        params: [],
        status: "pending",
        expiresAt: null,
        auto: false,
        allowForChat: false,
      },
    },
    connectorFailures: [],
    unsaved: [],
    outcome: null,
    saveFailed: false,
  };
  const html = renderToStaticMarkup(
    createElement(LiveBody, {
      live,
      run: null,
      connection: "open",
      connectors: [],
      tenantId: "t",
      onReconnect() {},
      onApprove() {},
      approvalBusy: null,
      files: [],
    }),
  );
  assert.equal((html.match(/Waiting for you</g) ?? []).length, 1);
  assert.match(html, /cs-work-sum[\s\S]*#i-hand[\s\S]*Using tools/);
  assert.doesNotMatch(html, /tx-spin/);
});
