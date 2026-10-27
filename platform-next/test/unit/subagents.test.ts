import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { loadChatConfig } from "../../src/config/chat-config";
import {
  plannedMessages,
  type ChatStore,
  type SettleItem,
  type Settlement,
} from "../../src/modules/chats/chat-store";
import {
  RunExecutor,
  type Dispatch,
  type LiveEvent,
} from "../../src/modules/chats/run-executor";
import {
  AdapterRefusal,
  type AdapterEvent,
  type RuntimeClient,
} from "../../src/modules/chats/runtime-client";

// Helper agents on the platform side: the operator setting, the live
// events, the saved rows and the two new error codes.

const full = {
  RUNTIME_ADAPTER_URL: "http://127.0.0.1:4400/",
  RUNTIME_ADAPTER_TOKEN: "a".repeat(32),
  MODEL_GATEWAY_URL: "https://gateway.example.test",
  MODEL_GATEWAY_SECRET: "b".repeat(32),
};

const reply = (itemId: string, text: string): SettleItem => ({
  type: "reply",
  itemId,
  text,
  completed: true,
});

function dispatchFor(runId: ObjectId): Dispatch {
  return {
    dbName: "truex_next_t",
    chatId: new ObjectId(),
    runId,
    ownerId: new ObjectId(),
    replySeq: 2,
    ref: { tenantId: "t", chatId: "c" },
    mode: "start",
    body: {} as Dispatch["body"],
  };
}

// Runs one adapter stream through the executor; returns what the browser
// saw and what was settled.
async function drive(
  events: AdapterEvent[] | (() => AsyncGenerator<AdapterEvent>),
) {
  let outcome: Settlement | undefined;
  const store = {
    markAccepted: async () => undefined,
    renewLease: async () => true,
    markUncertain: async () => undefined,
    settleWithRetry: async (...args: unknown[]) => {
      outcome = args[4] as Settlement;
      return { run: {}, messages: [] };
    },
  };
  const client = {
    startRun:
      typeof events === "function"
        ? events
        : async function* () {
            yield* events;
          },
  };
  const executor = new RunExecutor(
    store as unknown as ChatStore,
    client as unknown as RuntimeClient,
  );
  const runId = new ObjectId();
  const live: LiveEvent[] = [];
  executor.begin(dispatchFor(runId));
  executor.subscribe(runId, {
    send: (event) => live.push(event),
    end: () => undefined,
  });
  await executor.drain(5_000);
  return { live, outcome };
}

const accepted: AdapterEvent = {
  seq: 1,
  type: "run.accepted",
  data: { threadId: "t", turnId: "u" },
};

describe("CHAT_SUBAGENTS", () => {
  test("is off unless set to 1, 2 or 3", () => {
    const problems: string[] = [];
    assert.equal("subAgents" in loadChatConfig(full, problems)!, false);
    assert.equal(
      "subAgents" in
        loadChatConfig({ ...full, CHAT_SUBAGENTS: "off" }, problems)!,
      false,
    );
    for (const n of [1, 2, 3])
      assert.equal(
        loadChatConfig({ ...full, CHAT_SUBAGENTS: String(n) }, problems)
          ?.subAgents,
        n,
      );
    assert.deepEqual(problems, []);
  });

  test("rejects anything else", () => {
    for (const bad of ["0", "4", "on", "yes", "1.5", ""]) {
      const problems: string[] = [];
      loadChatConfig({ ...full, CHAT_SUBAGENTS: bad }, problems);
      assert.match(problems[0] ?? "", /CHAT_SUBAGENTS must be off, 1, 2 or 3/);
    }
  });
});

describe("saving helper agents", () => {
  test("one tool row per helper, before the lead's last reply", () => {
    const planned = plannedMessages(
      {},
      {
        status: "completed",
        items: [reply("a", "Checking."), reply("b", "Globex is at risk.")],
        agents: [
          {
            agentId: "th1",
            path: "/root/crm",
            status: "completed",
            preview: "live only",
            result: "Globex stalled 21 days.",
            usage: {
              input: 20,
              cached: 0,
              cacheWrite: 0,
              output: 10,
              reasoning: 0,
            },
          },
          { agentId: "th2", path: "/root/email", status: "running" },
        ],
      },
    );
    assert.deepEqual(
      planned.map((m) => [m.role, m.runtimeItemId]),
      [
        ["assistant", "a"],
        ["tool", "agent:th1"],
        ["tool", "agent:th2"],
        ["assistant", "b"],
      ],
    );
    assert.deepEqual(planned[1]!.agent, {
      path: "/root/crm",
      status: "completed",
      result: "Globex stalled 21 days.",
      usage: { input: 20, cached: 0, cacheWrite: 0, output: 10, reasoning: 0 },
    });
    // A helper still running at settle was stopped with the run.
    assert.equal(planned[2]!.agent?.status, "stopped");
    // The live preview is never saved.
    assert.ok(!JSON.stringify(planned).includes("live only"));
  });

  test("with no reply the rows come last; without helpers nothing changes", () => {
    const rows = plannedMessages(
      {},
      {
        status: "failed",
        items: [],
        agents: [{ agentId: "th1", path: "/root/a", status: "failed" }],
      },
    );
    assert.deepEqual(
      rows.map((m) => m.runtimeItemId),
      ["agent:th1"],
    );
    const without = plannedMessages(
      {},
      { status: "completed", items: [reply("a", "Hi.")] },
    );
    assert.equal(without.length, 1);
    assert.equal("agent" in without[0]!, false);
  });
});

describe("RunExecutor helper agents", () => {
  test("helper events stream live and reach the settlement", async () => {
    const { live, outcome } = await drive([
      accepted,
      {
        seq: 2,
        type: "agent.started",
        data: { agentId: "th1", path: "/root/crm" },
      },
      {
        seq: 3,
        type: "agent.activity",
        data: { agentId: "th1", status: "running", preview: "crm: list" },
      },
      // An unknown helper's update is ignored.
      {
        seq: 4,
        type: "agent.activity",
        data: { agentId: "nope", status: "running", preview: "x" },
      },
      {
        seq: 5,
        type: "agent.completed",
        data: {
          agentId: "th1",
          status: "completed",
          result: "Globex stalled.",
          usage: { inputTokens: 20, outputTokens: 10 },
        },
      },
      { seq: 6, type: "text.delta", data: { itemId: "a", delta: "Done." } },
      {
        seq: 7,
        type: "run.completed",
        data: {
          status: "completed",
          delivery: "accepted",
          items: [
            { type: "reply", itemId: "a", text: "Done.", completed: true },
          ],
          agents: [
            {
              agentId: "th1",
              path: "/root/crm",
              status: "completed",
              result: "Globex stalled.",
            },
          ],
        },
      },
    ]);
    const agents = live.filter((e) => e.type === "agent");
    assert.deepEqual(
      agents.map((e) => e.type === "agent" && [e.data.agentId, e.data.status]),
      [
        ["th1", "running"],
        ["th1", "running"],
        ["th1", "completed"],
        // The outcome's list is applied once more before settling.
        ["th1", "completed"],
      ],
    );
    assert.equal(outcome?.status, "completed");
    assert.equal(outcome?.agents?.length, 1);
    assert.equal(outcome?.agents?.[0]?.result, "Globex stalled.");
    assert.equal(outcome?.agents?.[0]?.usage?.input, 20);
    // Helper text never becomes a reply item.
    assert.deepEqual(
      outcome?.items.map((i) => i.type),
      ["reply"],
    );
    const completed = live.find((e) => e.type === "completed");
    assert.equal(
      completed?.type === "completed" && completed.data.agents?.length,
      1,
    );
  });

  test("a helper missed live is still saved from the outcome", async () => {
    const { outcome } = await drive([
      accepted,
      {
        seq: 2,
        type: "run.completed",
        data: {
          status: "stopped",
          delivery: "accepted",
          items: [],
          agents: [
            { agentId: "th9", path: "/root/late", status: "stopped" },
            { path: "no id" },
          ],
        },
      },
    ]);
    assert.deepEqual(
      outcome?.agents?.map((a) => [a.agentId, a.status]),
      [["th9", "stopped"]],
    );
  });

  test("helper text from the runtime is bounded", async () => {
    const { outcome } = await drive([
      accepted,
      {
        seq: 2,
        type: "run.completed",
        data: {
          status: "completed",
          delivery: "accepted",
          items: [],
          agents: [
            {
              agentId: "th1",
              path: "p".repeat(500),
              status: "weird",
              result: "r".repeat(10_000),
            },
          ],
        },
      },
    ]);
    const agent = outcome?.agents?.[0];
    assert.equal(agent?.path.length, 120);
    assert.equal(agent?.result?.length, 4000);
    assert.equal(agent?.status, "running");
  });

  test("runs without helpers carry no agents field", async () => {
    const { live, outcome } = await drive([
      accepted,
      {
        seq: 2,
        type: "run.completed",
        data: { status: "completed", delivery: "accepted", items: [] },
      },
    ]);
    assert.equal(outcome && "agents" in outcome, false);
    assert.equal(
      live.some((e) => e.type === "agent"),
      false,
    );
  });

  test("SUBAGENT_LIMIT keeps its own message", async () => {
    const { outcome } = await drive([
      accepted,
      {
        seq: 2,
        type: "run.completed",
        data: {
          status: "failed",
          delivery: "accepted",
          items: [],
          error: { code: "SUBAGENT_LIMIT" },
        },
      },
    ]);
    assert.equal(outcome?.error?.code, "SUBAGENT_LIMIT");
    assert.equal(outcome?.error?.retryable, false);
  });

  // Current adapters run helpers under coding; only an older adapter still
  // refuses them with SUBAGENTS_DISABLED, which the platform maps to a clear
  // failed run (not a raw error).
  test("an older adapter refusing helpers fails the run with SUBAGENTS_DISABLED", async () => {
    const { outcome } = await drive(async function* () {
      throw new AdapterRefusal(409, "SUBAGENTS_DISABLED", false);
      yield accepted;
    });
    assert.equal(outcome?.status, "failed");
    assert.equal(outcome?.error?.code, "SUBAGENTS_DISABLED");
  });
});
