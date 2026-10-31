import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  currentTiming,
  serverTiming,
  type RequestTiming,
} from "../../src/common/http/server-timing";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { ChatStore, type Settlement } from "../../src/modules/chats/chat-store";
import { BUILTIN_AGENTS_COLLECTION } from "../../src/modules/agents/builtin-agent";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
  type ChatDoc,
  type RunDoc,
} from "../../src/modules/chats/chat";
import { RecoverySweep } from "../../src/modules/chats/recovery-sweep";
import {
  RUNTIME_CLIENT,
  RunExecutor,
} from "../../src/modules/chats/run-executor";
import { ChatsService } from "../../src/modules/chats/chats.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import {
  GOAL_SLOTS_COLLECTION,
  GOALS_COLLECTION,
  type GoalDoc,
  type GoalSlotsDoc,
} from "../../src/modules/goals/goal";
import { GoalStore } from "../../src/modules/goals/goal-store";
import { GoalWatcher } from "../../src/modules/goals/goal-watcher";
import {
  AdapterRefusal,
  AdapterUnreachable,
  RuntimeClient,
  type ChatRef,
  type RuntimeGoal,
  type StartRunBody,
} from "../../src/modules/chats/runtime-client";
import { MEMBERSHIPS_COLLECTION } from "../../src/modules/memberships/membership";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { MODELS_COLLECTION } from "../../src/modules/models/model";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { SESSIONS_COLLECTION } from "../../src/modules/sessions/session";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { DEFAULT_TENANT_DB_NAME } from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import {
  builtinDefinition,
  modelDefinition,
} from "../support/catalog-fixtures";
import {
  ADAPTER_TOKEN,
  AdapterProcess,
  FakeGateway,
  GATEWAY_SECRET,
  readStream,
  sleep,
  type StreamEvent,
} from "../support/chat-stack";
import { resetOwnedData } from "../support/reset";
import { testAuthConfig } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

interface Member {
  userId: ObjectId;
  token: string;
  tenantId: ObjectId;
  sessionId: ObjectId;
  refreshCredential: string;
}

interface Receipt {
  chat: {
    id: string;
    title: string;
    activeRunId: string | null;
    readOnly: string | null;
    agent: { name: string } | null;
  };
  message: { id: string; seq: number; text: string; clientMessageId: string };
  run: { id: string; status: string };
}

interface ChatBody {
  chat: Receipt["chat"];
  messages: Array<{
    role: string;
    text: string;
    state: string;
    seq: number;
    runId: string;
  }>;
  runs: Array<{
    id: string;
    status: string;
    trigger?: string;
    error: { code: string; message: string } | null;
    usage: Record<string, number> | null;
    timings: Record<string, string>;
    steers?: Array<{ clientMessageId: string; text: string }>;
    followUps?: {
      items: Array<{ slot: number; intent: string; text: string }>;
    };
  }>;
  hasMore: boolean;
}

describe("chat: platform-next → runtime adapter → pinned Codex", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let operator: OperatorService;
  const gateway = new FakeGateway();
  const adapter = new AdapterProcess();
  let tenantId: ObjectId;
  let otherTenantId: ObjectId;
  let builtinId: string;
  let modelId: string;
  let alice: Member;
  let bob: Member;
  let dave: Member;
  let next = 0;

  // One signing key across restarts, so sessions survive a reboot.
  const auth: AppConfig["auth"] = testAuthConfig();

  // The recovery sweep is off unless a test asks for it (tests run it with
  // RecoverySweep.runOnce); the stream heartbeat, which re-checks access,
  // is short so revocation shows within a test.
  async function boot(
    chat: {
      recoverySweepMs?: number;
      streamHeartbeatMs?: number;
      followUps?: boolean;
      followUpsHoldoutPercent?: number;
      subAgents?: number;
    } = {},
  ): Promise<void> {
    running = await startApp({
      mongodbUri: mongo.getUri(),
      auth,
      chat: {
        adapterUrl: adapter.url,
        adapterToken: ADAPTER_TOKEN,
        gatewayUrl: gateway.url,
        gatewaySecret: GATEWAY_SECRET,
        recoverySweepMs: 0,
        streamHeartbeatMs: 300,
        ...chat,
      },
    });
    database = running.app.get(DatabaseService);
    operator = running.app.get(OperatorService);
  }

  before(async () => {
    mongo = await startReplicaSet();
    await gateway.start();
    await adapter.start();
    await boot();
  });

  after(async () => {
    await running?.close();
    await adapter.close();
    await gateway.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    gateway.release();
    gateway.script.length = 0;
    gateway.requests.length = 0;
    gateway.defaultBehavior = { kind: "reply", text: "Hello from the model." };
    await resetOwnedData(database);
    tenantId = new ObjectId();
    otherTenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId,
      name: "Truex",
      kind: "default",
    });
    await operator.provisionTenant({
      operator: "ops",
      tenantId: otherTenantId,
      name: "Acme",
      kind: "organization",
    });
    modelId = (
      await operator.putModel({
        operator: "ops",
        definition: modelDefinition(),
      })
    ).model.id;
    builtinId = (
      await operator.putBuiltinAgent({
        operator: "ops",
        definition: builtinDefinition({
          instructions: "BUILTIN_MARKER You help with anything.",
        }),
      })
    ).agent.id;
    alice = await member("alice", tenantId);
    bob = await member("bob", tenantId);
    dave = await member("dave", otherTenantId);
  });

  async function member(subject: string, tenant: ObjectId): Promise<Member> {
    const users = running.app.get(UsersService);
    const { user } = await users.findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: subject,
    });
    await running.app
      .get(MembershipsService)
      .join({ userId: user._id, tenantId: tenant, joinedVia: "signup" });
    // A token for the member's tenant, as the app gets from refresh.
    const sessions = running.app.get(SessionsService);
    const created = await sessions.create(user._id);
    const issued = await sessions.refresh(
      created.refreshCredential,
      new Date(),
      tenant,
    );
    assert.ok(issued.tenant?.tenantId.equals(tenant));
    return {
      userId: user._id,
      token: issued.accessToken,
      tenantId: tenant,
      sessionId: issued.sessionId,
      refreshCredential: issued.refreshCredential,
    };
  }

  function call(
    who: Member,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(
      `${running.baseUrl}/api/v1${path}${path.includes("?") ? "&" : "?"}tenantId=${who.tenantId.toHexString()}`,
      {
        method,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
    );
  }

  async function json<T>(res: Response, status: number): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, text);
    return JSON.parse(text) as T;
  }

  async function fails(res: Response, status: number, code: string) {
    const text = await res.text();
    assert.equal(res.status, status, text);
    assert.equal(JSON.parse(text).error.code, code, text);
    return text;
  }

  const clientId = () => `cm-${++next}-${Date.now()}`;

  function startChat(who: Member, text = "Hello there", agentId = builtinId) {
    return call(who, "POST", "/chats", {
      agentId,
      clientMessageId: clientId(),
      text,
    });
  }

  function stream(
    who: Member,
    chatId: string,
    runId: string,
    signal?: AbortSignal,
  ) {
    return call(
      who,
      "GET",
      `/chats/${chatId}/runs/${runId}/stream`,
      undefined,
      signal,
    );
  }

  async function finish(who: Member, receipt: Receipt): Promise<StreamEvent[]> {
    const res = await stream(who, receipt.chat.id, receipt.run.id);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    return readStream(res);
  }

  function getChat(who: Member, chatId: string) {
    return call(who, "GET", `/chats/${chatId}`).then((r) =>
      json<ChatBody>(r, 200),
    );
  }

  // What a browser shows: the snapshot, plus deltas, with whole-item
  // replacements winning.
  function textOf(events: StreamEvent[]): string {
    const items = new Map<string, string>();
    for (const { type, data } of events) {
      if (type === "snapshot")
        for (const i of data.items as Array<{ itemId: string; text: string }>)
          items.set(i.itemId, i.text);
      if (type === "delta")
        items.set(
          String(data.itemId),
          (items.get(String(data.itemId)) ?? "") + String(data.text),
        );
      if (type === "item") items.set(String(data.itemId), String(data.text));
    }
    return [...items.values()].join("");
  }

  const savedOf = (events: StreamEvent[]) => {
    const saved = events.at(-1);
    assert.equal(
      saved?.type,
      "saved",
      JSON.stringify(events.map((e) => e.type)),
    );
    return saved.data as {
      run: ChatBody["runs"][number];
      messages: ChatBody["messages"];
    };
  };

  test("first send creates the chat, streams the reply and saves it", async () => {
    gateway.defaultBehavior = {
      kind: "reply",
      text: "Paris is the capital of France.",
      chunk: 4,
    };
    const receipt = await json<Receipt>(
      await startChat(alice, "What is the capital of France?\nShort answer."),
      202,
    );
    assert.equal(
      receipt.chat.title,
      "What is the capital of France? Short answer.",
    );
    assert.equal(receipt.chat.agent?.name, "General Agent");
    assert.equal(receipt.message.seq, 1);
    assert.equal(receipt.chat.activeRunId, receipt.run.id);

    const events = await finish(alice, receipt);
    assert.equal(events[0]?.type, "snapshot");
    assert.equal(textOf(events), "Paris is the capital of France.");
    assert.ok(events.filter((e) => e.type === "delta").length >= 1);
    const completedAt = events.findIndex((e) => e.type === "completed");
    assert.ok(completedAt > 0 && completedAt < events.length - 1);
    const saved = savedOf(events);
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.messages[0]?.text, "Paris is the capital of France.");

    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.chat.activeRunId, null);
    assert.deepEqual(
      body.messages.map((m) => [m.seq, m.role, m.state, m.text]),
      [
        [
          1,
          "user",
          "complete",
          "What is the capital of France?\nShort answer.",
        ],
        [2, "assistant", "complete", "Paris is the capital of France."],
      ],
    );
    const run = body.runs[0]!;
    assert.equal(run.usage?.input, 20);
    assert.equal(run.usage?.cached, 5);
    assert.equal(run.usage?.output, 10);
    for (const t of [
      "acceptedAt",
      "dispatchedAt",
      "firstTextAt",
      "completedAt",
    ])
      assert.ok(run.timings[t], t);

    // The gateway got a token for this model and tenant, and the thread
    // started with the built-in's instructions.
    const request = gateway.requests[0]!;
    assert.equal(request.modelId, modelId);
    assert.equal(request.tenantId, tenantId.toHexString());
    assert.match(JSON.stringify(request.body), /BUILTIN_MARKER/);
    const chat = await database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .findOne({ _id: new ObjectId(receipt.chat.id) });
    assert.ok(chat);
    assert.equal(chat.platformInstructionsVersion, "v5");
    assert.equal(chat.followUps, "on");
    assert.ok(
      JSON.stringify(request.body).includes(
        `This chat started on ${chat.createdAt.toISOString().slice(0, 10)} (UTC).`,
      ),
      "the thread uses the persisted chat date",
    );
    assert.equal(gateway.refused, 0);
  });

  test("a completed reply's block is stripped and its rows stored", async () => {
    gateway.defaultBehavior = {
      kind: "reply",
      text: "The BAPI only stages the order.\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: Draft an ABAP report\nverify: Check the authorisation objects\n[/truex-suggestions]",
      chunk: 16,
    };
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const saved = savedOf(await finish(alice, receipt));
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.messages[0]?.text, "The BAPI only stages the order.");
    assert.deepEqual(saved.run.followUps, {
      items: [
        { slot: 1, intent: "act", text: "Draft an ABAP report" },
        { slot: 2, intent: "verify", text: "Check the authorisation objects" },
      ],
    });
    assert.doesNotMatch(JSON.stringify(saved.messages), /truex-suggestions/);

    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.messages[1]?.text, "The BAPI only stages the order.");
    assert.equal(body.runs[0]?.followUps?.items.length, 2);
    const raw = await runDoc(receipt.run.id);
    assert.deepEqual(raw?.followUps, {
      status: "ok",
      shape: "how-to",
      stage: "build",
      items: [
        { slot: 1, intent: "act", text: "Draft an ABAP report" },
        { slot: 2, intent: "verify", text: "Check the authorisation objects" },
      ],
    });
  });

  test("a half block on a stopped reply is stripped and stores no rows", async () => {
    gateway.script.push({
      kind: "held",
      before:
        "Partial answer.\n[truex-suggestions]\nshape: explain; stage: none\nact: Half a row",
      after: " never written.",
    });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const events = await streamUntil(receipt, "Partial answer", async () => {
      await json(
        await call(
          alice,
          "POST",
          `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stop`,
        ),
        202,
      );
    });
    gateway.release();
    const saved = savedOf(events);
    assert.equal(saved.run.status, "stopped");
    assert.equal(saved.messages[0]?.text, "Partial answer.");
    assert.doesNotMatch(
      JSON.stringify(saved.messages),
      /truex-suggestions|Half a row/,
    );
    assert.equal(saved.run.followUps, undefined);
    const raw = await runDoc(receipt.run.id);
    assert.equal(raw?.followUps, undefined);
  });

  test("a Follow Up click stores its origin; a steer drops it", async () => {
    gateway.defaultBehavior = {
      kind: "reply",
      text: "First answer.\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: Draft the report\n[/truex-suggestions]",
    };
    const first = await json<Receipt>(await startChat(alice), 202);
    savedOf(await finish(alice, first));
    const click = {
      clientMessageId: clientId(),
      text: "Draft the report",
      followUp: { fromRunId: first.run.id, slot: 1 },
    };
    const clicked = await json<Receipt>(
      await call(alice, "POST", `/chats/${first.chat.id}/messages`, click),
      202,
    );
    savedOf(await finish(alice, clicked));
    // The claim is analytics only: it never reaches the runtime, so it can
    // change neither the prompt nor any tool approval.
    const runtimeBody = JSON.stringify(gateway.requests.at(-1)?.body ?? {});
    assert.doesNotMatch(runtimeBody, /followUp|fromRunId/);
    assert.match(runtimeBody, /Draft the report/);
    const origin = (await runDoc(clicked.run.id))?.origin;
    assert.deepEqual(
      {
        source: origin?.source,
        fromRunId: origin?.fromRunId.toHexString(),
        slot: origin?.slot,
      },
      { source: "suggestion", fromRunId: first.run.id, slot: 1 },
    );
    // A retried send with the same clientMessageId is the same one run.
    const replay = await call(
      alice,
      "POST",
      `/chats/${first.chat.id}/messages`,
      click,
    );
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as Receipt).run.id, clicked.run.id);

    // Into a running reply, the message is a steer: no origin is stored.
    gateway.script.push({ kind: "held", before: "Working", after: "." });
    const second = await json<Receipt>(await startChat(alice), 202);
    const events = await streamUntil(second, "Working", async () => {
      const steer = await call(
        alice,
        "POST",
        `/chats/${second.chat.id}/messages`,
        {
          clientMessageId: clientId(),
          text: "Steer with a claim",
          followUp: { fromRunId: second.run.id, slot: 1 },
        },
      );
      assert.equal(steer.status, 202);
      assert.ok("steer" in ((await steer.json()) as object));
      await json(
        await call(
          alice,
          "POST",
          `/chats/${second.chat.id}/runs/${second.run.id}/stop`,
        ),
        202,
      );
    });
    gateway.release();
    assert.equal(savedOf(events).run.status, "stopped");
    assert.equal((await runDoc(second.run.id))?.origin, undefined);
  });

  test("FOLLOW_UPS=off hides stored rows and stripping continues", async () => {
    gateway.defaultBehavior = {
      kind: "reply",
      text: "Answer before the switch.\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: A row\n[/truex-suggestions]",
    };
    const first = await json<Receipt>(await startChat(alice), 202);
    assert.equal(
      savedOf(await finish(alice, first)).run.followUps?.items.length,
      1,
    );
    assert.equal((await chatDoc(first.chat.id))?.followUps, "on");

    await running.close();
    await boot({ followUps: false });
    try {
      const body = await getChat(alice, first.chat.id);
      assert.equal(body.runs[0]?.followUps, undefined);
      assert.equal(body.messages[1]?.text, "Answer before the switch.");

      const next = await json<Receipt>(await startChat(alice), 202);
      const saved = savedOf(await finish(alice, next));
      assert.equal(saved.messages[0]?.text, "Answer before the switch.");
      assert.equal(saved.run.followUps, undefined);
      assert.equal((await chatDoc(next.chat.id))?.followUps, "off");
      assert.equal((await runDoc(next.run.id))?.followUps, undefined);
      const prompt = JSON.stringify(gateway.requests.at(-1)?.body ?? {});
      assert.doesNotMatch(prompt, /truex-suggestions/);
    } finally {
      await running.close();
      await boot();
    }
  });

  test("helpers reach the runtime only with CHAT_SUBAGENTS and the agent's opt-in", async () => {
    const createAgent = async (helpers?: boolean) =>
      (
        await json<{ agent: { id: string; helpers: boolean } }>(
          await call(alice, "POST", "/agents", {
            clientRequestId: `req-${clientId()}`,
            scope: "personal",
            name: "Scout",
            description: "Finds sources.",
            modelId,
            ...(helpers !== undefined ? { helpers } : {}),
          }),
          201,
        )
      ).agent;
    // The start-run body of a chat started through `agentId`. The chat keeps
    // the agent's opt-in whatever the server flag says.
    async function bodyFor(
      agentId: string,
      optedIn: boolean,
    ): Promise<StartRunBody> {
      const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
      const bodies: StartRunBody[] = [];
      const original = client.startRun.bind(client);
      client.startRun = (body, signal) => {
        bodies.push(body);
        return original(body, signal);
      };
      try {
        const receipt = await json<Receipt>(
          await startChat(alice, "hi", agentId),
          202,
        );
        await finish(alice, receipt);
        assert.equal(
          (await chatDoc(receipt.chat.id))?.helpers,
          optedIn ? true : undefined,
        );
      } finally {
        client.startRun = original;
      }
      assert.equal(bodies.length, 1);
      return bodies[0]!;
    }

    const on = await createAgent(true);
    const off = await createAgent();
    assert.equal(on.helpers, true);
    assert.equal(off.helpers, false);
    // Server flag off: no field, even for an agent that opted in.
    assert.equal("subAgents" in (await bodyFor(on.id, true)), false);
    // The list tells the dialog whether to offer the setting.
    assert.equal(
      (
        await json<{ helpers: boolean }>(
          await call(alice, "GET", "/agents"),
          200,
        )
      ).helpers,
      false,
    );

    await running.close();
    await boot({ subAgents: 2 });
    try {
      assert.equal(
        (
          await json<{ helpers: boolean }>(
            await call(alice, "GET", "/agents"),
            200,
          )
        ).helpers,
        true,
      );
      assert.deepEqual((await bodyFor(on.id, true)).subAgents, {
        maxConcurrent: 2,
      });
      assert.equal("subAgents" in (await bodyFor(off.id, false)), false);
      assert.equal("subAgents" in (await bodyFor(builtinId, false)), false);
    } finally {
      await running.close();
      await boot();
    }
  });

  test("a chat snapshots the tenant's goal maximum at creation and sends it on every run", async () => {
    const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
    const bodies: StartRunBody[] = [];
    const original = client.startRun.bind(client);
    client.startRun = (body, signal) => {
      bodies.push(body);
      return original(body, signal);
    };
    // The run body of one finished first send or follow-up.
    async function runBody(res: Promise<Response>) {
      const receipt = await json<Receipt>(await res, 202);
      await finish(alice, receipt);
      assert.equal(bodies.length, 1);
      const body = bodies.pop()!;
      return { chatId: receipt.chat.id, body };
    }
    const followUp = (chatId: string) =>
      runBody(
        call(alice, "POST", `/chats/${chatId}/messages`, {
          clientMessageId: clientId(),
          text: "And then?",
        }),
      );
    const tenantGoals = async () =>
      (
        await json<{ tenant: { goals: unknown } }>(
          await call(alice, "GET", "/tenant"),
          200,
        )
      ).tenant.goals;
    const settings = (maxTokenBudget: number) => ({
      presets: [100_000, 300_000, 1_000_000],
      maxTokenBudget,
      maxActive: 10,
    });
    try {
      // A tenant without settings: nothing, as today.
      assert.equal(await tenantGoals(), null);
      const older = await runBody(startChat(alice));
      assert.equal("goals" in older.body, false);
      assert.equal("goals" in ((await chatDoc(older.chatId)) ?? {}), false);

      await operator.setTenantGoals({
        operator: "ops",
        tenantId,
        goals: settings(3_000_000),
      });
      // The member sees the presets and the maximum, not the tenant cap.
      assert.deepEqual(await tenantGoals(), {
        presets: [100_000, 300_000, 1_000_000],
        maxTokenBudget: 3_000_000,
      });
      const goalChat = await runBody(startChat(alice));
      assert.deepEqual(goalChat.body.goals, { maxTokenBudget: 3_000_000 });
      // The chat view says goals are on, so the Goal button can show.
      const view = async (chatId: string) =>
        (
          await json<{ chat: { goals: unknown } }>(
            await call(alice, "GET", `/chats/${chatId}`),
            200,
          )
        ).chat.goals;
      assert.deepEqual(await view(goalChat.chatId), {
        maxTokenBudget: 3_000_000,
      });
      assert.equal(await view(older.chatId), null);
      assert.deepEqual((await chatDoc(goalChat.chatId))?.goals, {
        maxTokenBudget: 3_000_000,
      });
      // A chat created before the settings stays without goals.
      assert.equal("goals" in (await followUp(older.chatId)).body, false);

      // New settings reach new chats only.
      await operator.setTenantGoals({
        operator: "ops",
        tenantId,
        goals: settings(5_000_000),
      });
      assert.deepEqual((await followUp(goalChat.chatId)).body.goals, {
        maxTokenBudget: 3_000_000,
      });
      assert.deepEqual((await runBody(startChat(alice))).body.goals, {
        maxTokenBudget: 5_000_000,
      });

      await operator.removeTenantGoals({ operator: "ops", tenantId });
      assert.equal(await tenantGoals(), null);
      assert.deepEqual((await followUp(goalChat.chatId)).body.goals, {
        maxTokenBudget: 3_000_000,
      });
      assert.equal("goals" in (await runBody(startChat(alice))).body, false);
      assert.deepEqual((await chatDoc(goalChat.chatId))?.goals, {
        maxTokenBudget: 3_000_000,
      });
    } finally {
      client.startRun = original;
    }
  });

  test("a retried first send keeps its holdout draw", async () => {
    await running.close();
    await boot({ followUpsHoldoutPercent: 50 });
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.1;
      const input = {
        agentId: builtinId,
        clientMessageId: clientId(),
        text: "Is this chat a holdout?",
      };
      const first = await json<Receipt>(
        await call(alice, "POST", "/chats", input),
        202,
      );
      Math.random = originalRandom;
      savedOf(await finish(alice, first));
      const retry = await json<Receipt>(
        await call(alice, "POST", "/chats", input),
        200,
      );
      assert.equal(retry.chat.id, first.chat.id);
      assert.equal((await chatDoc(first.chat.id))?.followUps, "holdout");
      assert.equal((await runDoc(first.run.id))?.followUps, undefined);
    } finally {
      Math.random = originalRandom;
      await running.close();
      await boot();
    }
  });

  // Server-Timing entries in order, each with its MongoDB call count. A
  // connection the pool happened to open is left out: it depends on load.
  function timingOf(res: Response): Array<[string, number]> {
    const header = res.headers.get("server-timing") ?? "";
    return header
      .split(", ")
      .map((entry): [string, number] => {
        const [name = "", ...params] = entry.split(";");
        const dur = Number(params.find((p) => p.startsWith("dur="))?.slice(4));
        assert.ok(Number.isFinite(dur) && dur >= 0, entry);
        const calls = /\((\d+) (?:db )?calls?\)/.exec(entry)?.[1];
        return [name, Number(calls ?? 0)];
      })
      .filter(([name]) => name !== "db-connect");
  }

  test("Server-Timing shows each step with its MongoDB calls", async () => {
    gateway.script.push(
      { kind: "held", before: "Partial", after: " reply." },
      { kind: "reply", text: "Second." },
    );
    // The picker loads the catalog cache, and opening the tenant loads its
    // goal settings, as the app does before a start.
    await json(await call(alice, "GET", "/tenant"), 200);
    await json(await call(alice, "GET", "/agents"), 200);
    const started = await startChat(alice);
    const receipt = await json<Receipt>(started, 202);
    const start = timingOf(started);
    // Access comes from the tenant token, the built-in and the model from
    // the catalog cache; the chat, message and run are one write plus the
    // commit. No index check, no retry read, no view read.
    assert.deepEqual(start, [
      ["auth", 0],
      ["agent", 0],
      ["model", 0],
      ["save", 2],
      ["db", 2],
      ["total", 0],
    ]);

    // A live reply this process is reading for alice streams without a
    // read; its reader is not counted here.
    const live = await stream(alice, receipt.chat.id, receipt.run.id);
    assert.deepEqual(timingOf(live), [
      ["auth", 0],
      ["db", 0],
      ["total", 0],
    ]);
    await gateway.waitForRequests(1);
    gateway.release();
    assert.equal(savedOf(await readStream(live)).run.status, "completed");

    // A reply finished here is still held for late subscribers.
    const done = await stream(alice, receipt.chat.id, receipt.run.id);
    assert.equal(
      savedOf(await readStream(done)).messages[0]?.text,
      "Partial reply.",
    );
    assert.deepEqual(timingOf(done), [
      ["auth", 0],
      ["db", 0],
      ["total", 0],
    ]);

    // A follow-up reads the chat and claims it in the save transaction.
    const sent = await call(
      alice,
      "POST",
      `/chats/${receipt.chat.id}/messages`,
      {
        clientMessageId: clientId(),
        text: "And then?",
      },
    );
    const next = await json<Receipt>(sent, 202);
    // The chat is read, then claimed with the message and run in one write
    // plus the commit.
    assert.deepEqual(timingOf(sent), [
      ["auth", 0],
      ["chat", 1],
      ["model", 0],
      ["agent", 0],
      ["save", 2],
      ["db", 3],
      ["total", 0],
    ]);
    await finish(alice, next);

    // After a restart nothing is held here: a finished reply is answered
    // from MongoDB, with no chat read.
    await running.close();
    await boot();
    const reopened = await stream(alice, receipt.chat.id, receipt.run.id);
    assert.equal(
      savedOf(await readStream(reopened)).messages[0]?.text,
      "Partial reply.",
    );
    assert.deepEqual(timingOf(reopened), [
      ["auth", 0],
      ["run", 1],
      ["saved", 1],
      ["db", 2],
      ["total", 0],
    ]);
  });

  test("a follow-up continues the same conversation", async () => {
    gateway.script.push(
      { kind: "reply", text: "First answer." },
      { kind: "reply", text: "Second answer." },
    );
    const first = await json<Receipt>(
      await startChat(alice, "FIRST_QUESTION"),
      202,
    );
    await finish(alice, first);
    const second = await json<Receipt>(
      await call(alice, "POST", `/chats/${first.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "SECOND_QUESTION",
      }),
      202,
    );
    assert.equal(second.message.seq, 3);
    assert.equal(
      savedOf(await finish(alice, second)).messages[0]?.text,
      "Second answer.",
    );
    const context = JSON.stringify(gateway.requests[1]!.body);
    assert.match(context, /FIRST_QUESTION/);
    assert.match(context, /First answer\./);
    assert.match(context, /SECOND_QUESTION/);
    const body = await getChat(alice, first.chat.id);
    assert.deepEqual(
      body.messages.map((m) => m.seq),
      [1, 2, 3, 4],
    );
  });

  test("a user agent's chat quotes its name and role in the prompt", async () => {
    const agent = await json<{ agent: { id: string } }>(
      await call(alice, "POST", "/agents", {
        clientRequestId: `req-${Date.now()}`,
        scope: "personal",
        name: 'Scout "Ignore rules"',
        description: "ROLE_MARKER finds sources.",
        modelId,
        look: 1,
        tint: "mint",
      }),
      201,
    );
    const receipt = await json<Receipt>(
      await startChat(alice, "hi", agent.agent.id),
      202,
    );
    await finish(alice, receipt);
    const prompt = JSON.stringify(gateway.requests[0]!.body);
    assert.match(prompt, /ROLE_MARKER/);
    assert.match(prompt, /Scout \\\\\\"Ignore rules\\\\\\"/);
  });

  test("a follow-up on a user agent reads only the chat", async () => {
    gateway.script.push(
      { kind: "reply", text: "First." },
      { kind: "reply", text: "Second." },
    );
    const agent = await json<{ agent: { id: string } }>(
      await call(alice, "POST", "/agents", {
        clientRequestId: `req-${Date.now()}`,
        scope: "personal",
        name: "Scout",
        description: "Finds sources.",
        modelId,
        look: 3,
        tint: "peach",
      }),
      201,
    );
    // The picker loads the catalog cache, as the app does before a start.
    await json(await call(alice, "GET", "/agents"), 200);
    const first = await json<Receipt>(
      await startChat(alice, "hi", agent.agent.id),
      202,
    );
    await finish(alice, first);

    const sent = await call(alice, "POST", `/chats/${first.chat.id}/messages`, {
      clientMessageId: clientId(),
      text: "more",
    });
    const next = await json<Record<string, Record<string, unknown>>>(sent, 202);
    // The thread already has the agent's prompt: no agent read, and no view
    // read for its display fields, which the caller already has.
    assert.deepEqual(timingOf(sent), [
      ["auth", 0],
      ["chat", 1],
      ["model", 0],
      ["save", 2],
      ["db", 3],
      ["total", 0],
    ]);
    assert.equal("agent" in next.chat!, false);
    assert.equal(next.chat!.readOnly, null);
    assert.equal(next.chat!.activeRunId, next.run!.id);
    assert.equal(next.chat!.title, "hi");
    await finish(alice, next as unknown as Receipt);

    // Reading the chat still shows its agent.
    const body = await getChat(alice, first.chat.id);
    assert.equal(body.chat.agent?.name, "Scout");
  });

  test("retried sends return the same receipt; conflicting reuse is refused", async () => {
    const body = {
      agentId: builtinId,
      clientMessageId: clientId(),
      text: "once",
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(alice, "POST", "/chats", body)),
    );
    const receipts = await Promise.all(
      results.map(async (res) => {
        assert.ok(res.status === 202 || res.status === 200, String(res.status));
        return (await res.json()) as Receipt;
      }),
    );
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    assert.equal(new Set(receipts.map((r) => r.chat.id)).size, 1);
    assert.equal(new Set(receipts.map((r) => r.run.id)).size, 1);
    await finish(alice, receipts[0]!);

    await fails(
      await call(alice, "POST", "/chats", { ...body, text: "different" }),
      409,
      "CONFLICT",
    );
    const list = await json<{ chats: unknown[] }>(
      await call(alice, "GET", "/chats"),
      200,
    );
    assert.equal(list.chats.length, 1);
    assert.equal(gateway.requests.length, 1);
  });

  test("a retried start returns its chat even after the agent is archived", async () => {
    const agent = await json<{ agent: { id: string } }>(
      await call(alice, "POST", "/agents", {
        clientRequestId: `req-${Date.now()}`,
        scope: "personal",
        name: "Scout",
        description: "Finds sources.",
        modelId,
        look: 1,
        tint: "mint",
      }),
      201,
    );
    // The picker loads the catalog cache, as the app does before a start.
    await json(await call(alice, "GET", "/agents"), 200);
    const body = {
      agentId: agent.agent.id,
      clientMessageId: clientId(),
      text: "find it",
    };
    const started = await call(alice, "POST", "/chats", body);
    const first = await json<Receipt>(started, 202);
    // A user agent is one tenant read; the model comes from the cache.
    assert.deepEqual(
      timingOf(started).filter(([name]) => name === "agent"),
      [["agent", 1]],
    );
    await finish(alice, first);
    await json(
      await call(alice, "POST", `/agents/${agent.agent.id}/archive`),
      200,
    );
    const retried = await json<Receipt>(
      await call(alice, "POST", "/chats", body),
      200,
    );
    assert.equal(retried.chat.id, first.chat.id);
    assert.equal(retried.run.id, first.run.id);
    // A new message with the archived agent is still refused.
    await fails(
      await startChat(alice, "again", agent.agent.id),
      404,
      "NOT_FOUND",
    );
    assert.equal(gateway.requests.length, 1);
  });

  test("a retried follow-up returns the same receipt, while streaming and after", async () => {
    gateway.script.push(
      { kind: "reply", text: "First." },
      { kind: "held", before: "Second", after: "." },
    );
    const first = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, first);
    const body = { clientMessageId: clientId(), text: "more" };
    const path = `/chats/${first.chat.id}/messages`;
    const sent = await json<Receipt>(
      await call(alice, "POST", path, body),
      202,
    );
    await gateway.waitForRequests(2);
    // While its reply streams the chat is busy, but this is the same message.
    const during = await json<Receipt>(
      await call(alice, "POST", path, body),
      200,
    );
    assert.equal(during.run.id, sent.run.id);
    gateway.release();
    await finish(alice, sent);
    // After the reply the chat is free: the save hits the unique index and
    // is rolled back, claim included.
    const after = await json<Receipt>(
      await call(alice, "POST", path, body),
      200,
    );
    assert.equal(after.run.id, sent.run.id);
    assert.equal(after.message.seq, 3);
    await fails(
      await call(alice, "POST", path, { ...body, text: "other" }),
      409,
      "CONFLICT",
    );
    const chat = await getChat(alice, first.chat.id);
    assert.equal(chat.chat.activeRunId, null);
    assert.deepEqual(
      chat.messages.map((m) => m.seq),
      [1, 2, 3, 4],
    );
    // The chat still takes a new message.
    const next = await json<Receipt>(
      await call(alice, "POST", path, {
        clientMessageId: clientId(),
        text: "x",
      }),
      202,
    );
    assert.equal(next.message.seq, 5);
    await finish(alice, next);
    assert.equal(gateway.requests.length, 3);
  });

  test("different messages racing on an idle chat: one is taken", async () => {
    const first = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, first);
    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        call(alice, "POST", `/chats/${first.chat.id}/messages`, {
          clientMessageId: clientId(),
          text: `racer ${i}`,
        }),
      ),
    );
    const statuses = attempts.map((res) => res.status).sort();
    assert.deepEqual(statuses, [202, 409, 409, 409]);
    for (const res of attempts)
      if (res.status === 409) await fails(res, 409, "CHAT_BUSY");
    const taken = await json<Receipt>(
      attempts.find((res) => res.status === 202)!,
      202,
    );
    assert.equal(taken.message.seq, 3);
    await finish(alice, taken);
    const chat = await getChat(alice, first.chat.id);
    assert.equal(
      chat.messages.filter((m) => m.role === "user").length,
      2,
      "one message per accepted send",
    );
  });

  test("a model or built-in added after the catalog cache loaded is used at once", async () => {
    // Load the cache, then add both behind its back, as the operator CLI
    // (another process) does.
    await json(await call(alice, "GET", "/agents"), 200);
    const catalog = database.catalog();
    const model = await catalog
      .collection(MODELS_COLLECTION)
      .findOne({ _id: new ObjectId(modelId) });
    const builtin = await catalog
      .collection(BUILTIN_AGENTS_COLLECTION)
      .findOne({ _id: new ObjectId(builtinId) });
    assert.ok(model && builtin);
    const newModelId = new ObjectId();
    const newBuiltinId = new ObjectId();
    await catalog
      .collection(MODELS_COLLECTION)
      .insertOne({ ...model, _id: newModelId, slug: "added-later" });
    await catalog.collection(BUILTIN_AGENTS_COLLECTION).insertOne({
      ...builtin,
      _id: newBuiltinId,
      slug: "added-later",
      name: "Added Later",
      modelId: newModelId,
    });
    const started = await startChat(alice, "hi", newBuiltinId.toHexString());
    const receipt = await json<Receipt>(started, 202);
    assert.equal(receipt.chat.agent?.name, "Added Later");
    assert.equal(receipt.chat.readOnly, null);
    await finish(alice, receipt);
    // The sidebar names it too, before the cache reloads.
    const list = await json<{ chats: Array<Receipt["chat"]> }>(
      await call(alice, "GET", "/chats"),
      200,
    );
    assert.equal(list.chats[0]?.agent?.name, "Added Later");
    assert.equal(list.chats[0]?.readOnly, null);
  });

  interface SteerReceipt {
    chat: Receipt["chat"];
    run: { id: string; status: string; steers?: Array<{ text: string }> };
    steer: { clientMessageId: string; text: string; createdAt: string };
    message?: undefined;
    created: boolean;
  }

  const sendTo = (
    who: Member,
    chatId: string,
    clientMessageId: string,
    text: string,
  ) =>
    call(who, "POST", `/chats/${chatId}/messages`, { clientMessageId, text });

  // Reads a reply's stream, calling `onText` once, when its text first
  // includes `marker`; resolves with every event.
  async function streamUntil(
    receipt: Receipt,
    marker: string,
    onText: () => Promise<void>,
  ): Promise<StreamEvent[]> {
    const res = await stream(alice, receipt.chat.id, receipt.run.id);
    let fired = false;
    return readStream(res, async (event) => {
      const text =
        event.type === "delta" || event.type === "item"
          ? String(event.data.text)
          : "";
      if (!fired && text.includes(marker)) {
        fired = true;
        await onText();
      }
    });
  }

  test("a message sent while a reply streams steers it, saved in the runtime's order", async () => {
    gateway.script.push({ kind: "held", before: "Working on", after: " it." });
    gateway.defaultBehavior = { kind: "reply", text: "Steered answer." };
    const first = await json<Receipt>(await startChat(alice), 202);
    const steerId = clientId();
    let steered!: SteerReceipt;
    const events = await streamUntil(first, "Working", async () => {
      steered = await json<SteerReceipt>(
        await sendTo(alice, first.chat.id, steerId, "Actually, be brief."),
        202,
      );
      // The same ID with other text is refused, whatever the reply's state.
      await fails(
        await sendTo(alice, first.chat.id, steerId, "something else"),
        409,
        "CONFLICT",
      );
      // A retry while the reply streams is the same steer, not a new one.
      const retried = await json<SteerReceipt>(
        await sendTo(alice, first.chat.id, steerId, "Actually, be brief."),
        200,
      );
      assert.equal(retried.created, false);
      assert.equal(retried.steer.createdAt, steered.steer.createdAt);
      // A reload while the reply streams shows the steer on its run.
      const reloaded = await getChat(alice, first.chat.id);
      assert.deepEqual(
        reloaded.runs
          .find((r) => r.id === first.run.id)
          ?.steers?.map((s) => s.clientMessageId),
        [steerId],
      );
    });
    assert.equal(steered.run.id, first.run.id);
    assert.equal(steered.steer.text, "Actually, be brief.");
    assert.equal(steered.message, undefined);
    assert.deepEqual(
      steered.run.steers?.map((s) => s.text),
      ["Actually, be brief."],
    );

    const input = events.find((e) => e.type === "input");
    assert.equal(input?.data.clientMessageId, steerId);
    const saved = savedOf(events);
    assert.equal(saved.run.status, "completed");
    assert.deepEqual(
      saved.messages.map((m) => [m.role, m.text, m.state]),
      [
        ["assistant", "Working on", "interrupted"],
        ["user", "Actually, be brief.", "complete"],
        ["assistant", "Steered answer.", "complete"],
      ],
    );
    // The model answered again with the steer, and never saw the cut text.
    assert.equal(gateway.requests.length, 2);
    const resent = JSON.stringify(gateway.requests[1]?.body);
    assert.match(resent, /Actually, be brief\./);
    assert.doesNotMatch(resent, /Working on/);

    const body = await getChat(alice, first.chat.id);
    assert.equal(body.chat.activeRunId, null);
    assert.deepEqual(
      body.messages.map((m) => [m.seq, m.role, m.state]),
      [
        [1, "user", "complete"],
        [2, "assistant", "interrupted"],
        [3, "user", "complete"],
        [4, "assistant", "complete"],
      ],
    );
    assert.equal(body.runs[0]?.steers, undefined, "settled runs hide steers");
    // A retry of the steer after it was saved is its saved message.
    const replay = await json<Receipt>(
      await sendTo(alice, first.chat.id, steerId, "Actually, be brief."),
      200,
    );
    assert.equal(replay.message.seq, 3);

    // The chat goes on after the steered reply.
    const next = await json<Receipt>(
      await sendTo(alice, first.chat.id, clientId(), "thanks"),
      202,
    );
    assert.equal(next.message.seq, 5);
    assert.equal(savedOf(await finish(alice, next)).run.status, "completed");
  });

  test("a steer sent before the reply has any text joins the turn", async () => {
    gateway.script.push({ kind: "held", before: "Early", after: " text." });
    gateway.defaultBehavior = { kind: "reply", text: "Both answered." };
    const first = await json<Receipt>(await startChat(alice), 202);
    const steered = await json<SteerReceipt>(
      await sendTo(alice, first.chat.id, clientId(), "PS: in French"),
      202,
    );
    assert.equal(steered.run.id, first.run.id);
    // Codex may take the steer before the first model request or cut it.
    await gateway.waitForRequests(2);
    if (gateway.requests.length < 2) gateway.release();
    const saved = savedOf(await finish(alice, first));
    assert.equal(saved.run.status, "completed");
    const steer = saved.messages.find((m) => m.role === "user");
    assert.equal(steer?.text, "PS: in French");
    assert.equal(steer?.state, "complete");
    assert.equal(saved.messages.at(-1)?.role, "assistant");
    assert.equal(saved.messages.at(-1)?.state, "complete");
    assert.match(
      JSON.stringify(gateway.requests.at(-1)?.body),
      /PS: in French/,
    );
  });

  test("a reply takes five steers; the sixth is refused and the draft is the caller's", async () => {
    gateway.defaultBehavior = { kind: "held", before: "Thinking", after: "." };
    const first = await json<Receipt>(await startChat(alice), 202);
    const sent: string[] = [];
    await streamUntil(first, "Thinking", async () => {
      for (let i = 1; i <= 5; i++) {
        const text = `steer number ${i}`;
        await json<SteerReceipt>(
          await sendTo(alice, first.chat.id, clientId(), text),
          202,
        );
        sent.push(text);
      }
      await fails(
        await sendTo(alice, first.chat.id, clientId(), "one too many"),
        409,
        "STEER_LIMIT",
      );
      await json(
        await call(
          alice,
          "POST",
          `/chats/${first.chat.id}/runs/${first.run.id}/stop`,
        ),
        202,
      );
    });
    gateway.release();
    const body = await getChat(alice, first.chat.id);
    assert.equal(body.chat.activeRunId, null);
    assert.equal(body.runs[0]?.status, "stopped");
    const steers = body.messages.filter((m) => m.role === "user").slice(1);
    assert.deepEqual(
      steers.map((m) => m.text),
      sent,
    );
    for (const m of steers)
      assert.ok(["complete", "not_sent"].includes(m.state), m.state);
    // One message per seq, no gaps.
    assert.deepEqual(
      body.messages.map((m) => m.seq),
      body.messages.map((_, i) => i + 1),
    );
    assert.ok(!body.messages.some((m) => m.text === "one too many"));
  });

  test("a message sent while a reply is stopping becomes the next message", async () => {
    gateway.script.push({ kind: "held", before: "Long answer", after: " end" });
    const first = await json<Receipt>(await startChat(alice), 202);
    let next!: Receipt;
    const events = await streamUntil(first, "Long", async () => {
      await json(
        await call(
          alice,
          "POST",
          `/chats/${first.chat.id}/runs/${first.run.id}/stop`,
        ),
        202,
      );
      next = await json<Receipt>(
        await sendTo(alice, first.chat.id, clientId(), "never mind, this"),
        202,
      );
    });
    const stopped = savedOf(events);
    assert.equal(stopped.run.status, "stopped");
    assert.ok(!stopped.messages.some((m) => m.role === "user"));
    assert.notEqual(next.run.id, first.run.id);
    assert.equal(next.message.text, "never mind, this");
    assert.equal(savedOf(await finish(alice, next)).run.status, "completed");
    assert.equal(gateway.requests.length, 2);
  });

  test("a message that arrives as a reply ends waits for it to be saved, then is sent once", async () => {
    const store = running.app.get(ChatStore);
    const realSettle = store.settle.bind(store);
    store.settleRetryDelaysMs = [1_500];
    let attempts = 0;
    // The reply has finished in the runtime but is not saved yet.
    store.settle = async (...args) => {
      if (++attempts === 1) throw new Error("simulated slow save");
      return realSettle(...args);
    };
    try {
      gateway.script.push({ kind: "reply", text: "First." });
      const first = await json<Receipt>(await startChat(alice), 202);
      for (let i = 0; i < 100 && attempts === 0; i++) await sleep(20);
      assert.equal(attempts, 1);
      const late = await json<Receipt>(
        await sendTo(alice, first.chat.id, clientId(), "late one"),
        202,
      );
      assert.notEqual(late.run.id, first.run.id);
      assert.equal(late.message.text, "late one");
      assert.equal(savedOf(await finish(alice, late)).run.status, "completed");
      const body = await getChat(alice, first.chat.id);
      assert.deepEqual(
        body.messages.map((m) => [m.seq, m.role, m.text]),
        [
          [1, "user", "Hello there"],
          [2, "assistant", "First."],
          [3, "user", "late one"],
          [4, "assistant", "Hello from the model."],
        ],
      );
      assert.equal(gateway.requests.length, 2);
    } finally {
      store.settle = realSettle;
      store.settleRetryDelaysMs = [500];
    }
  });

  test("stop keeps the partial text, is safe to repeat, and the chat goes on", async () => {
    gateway.script.push({
      kind: "held",
      before: "Partial answer",
      after: " never sent",
    });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const res = await stream(alice, receipt.chat.id, receipt.run.id);
    let stopped = false;
    const events = await readStream(res, async (event) => {
      const text =
        event.type === "delta" || event.type === "item"
          ? String(event.data.text)
          : "";
      if (!stopped && text.includes("Partial")) {
        stopped = true;
        const path = `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stop`;
        const [a, b] = await Promise.all([
          call(alice, "POST", path),
          call(alice, "POST", path),
        ]);
        assert.equal(a.status, 202);
        assert.equal(b.status, 202);
      }
    });
    const saved = savedOf(events);
    assert.equal(saved.run.status, "stopped");
    assert.equal(saved.messages[0]?.state, "stopped");
    assert.equal(saved.messages[0]?.text, "Partial answer");
    // Stopping a settled reply reports its outcome.
    const again = await call(
      alice,
      "POST",
      `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stop`,
    );
    assert.equal(
      (await json<{ status: string }>(again, 202)).status,
      "stopped",
    );

    gateway.release();
    const followUp = await json<Receipt>(
      await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "continue",
      }),
      202,
    );
    assert.equal(
      savedOf(await finish(alice, followUp)).run.status,
      "completed",
    );
  });

  test("a provider failure is saved with a safe message", async () => {
    gateway.script.push({ kind: "failed", code: "context_length_exceeded" });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const events = await finish(alice, receipt);
    const saved = savedOf(events);
    assert.equal(saved.run.status, "failed");
    assert.ok(saved.run.error?.code);
    assert.ok(saved.run.error?.message);
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.chat.activeRunId, null);
    assert.doesNotMatch(JSON.stringify({ events, body }), /provider detail/);
  });

  test("closing the browser stream does not stop the reply", async () => {
    gateway.script.push({
      kind: "held",
      before: "Half",
      after: " and the rest.",
    });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const abort = new AbortController();
    const res = await stream(
      alice,
      receipt.chat.id,
      receipt.run.id,
      abort.signal,
    );
    await readStream(res, (event) => {
      if (event.type === "delta") abort.abort();
    }).catch(() => undefined);
    gateway.release();
    // Reconnecting gets the snapshot and the saved outcome.
    const events = await finish(alice, receipt);
    assert.equal(events[0]?.type, "snapshot");
    assert.equal(savedOf(events).messages[0]?.text, "Half and the rest.");
  });

  test("chats are private to their owner", async () => {
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, receipt);
    const { id } = receipt.chat;
    await fails(await call(bob, "GET", `/chats/${id}`), 404, "NOT_FOUND");
    await fails(
      await call(bob, "GET", `/chats/${id}/runs/${receipt.run.id}/stream`),
      404,
      "NOT_FOUND",
    );
    await fails(
      await call(bob, "POST", `/chats/${id}/messages`, {
        clientMessageId: clientId(),
        text: "hi",
      }),
      404,
      "NOT_FOUND",
    );
    await fails(
      await call(bob, "PATCH", `/chats/${id}`, { title: "x" }),
      404,
      "NOT_FOUND",
    );
    await fails(await call(dave, "GET", `/chats/${id}`), 404, "NOT_FOUND");
    await fails(await call(bob, "GET", `/chats/not-an-id`), 404, "NOT_FOUND");
    const bobs = await json<{ chats: unknown[] }>(
      await call(bob, "GET", "/chats"),
      200,
    );
    assert.equal(bobs.chats.length, 0);
  });

  test("answerApproval refuses bad input, another member's chat and a settled run", async () => {
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, receipt);
    const { id } = receipt.chat;
    const okId = `ap_${"0".repeat(8)}-0000-0000-0000-000000000000`;
    const path = (approvalId: string) =>
      `/chats/${id}/runs/${receipt.run.id}/approvals/${approvalId}`;

    // An unknown decision (and an "expired"/"cancelled" that are decisions
    // but not answers) is a 400 before anything reaches the runtime.
    for (const decision of ["maybe", "expired", "cancelled"])
      await fails(
        await call(alice, "POST", path(okId), { decision }),
        400,
        "BAD_REQUEST",
      );
    // Unknown body fields are refused too.
    await fails(
      await call(alice, "POST", path(okId), { decision: "allow", extra: 1 }),
      400,
      "BAD_REQUEST",
    );
    // A malformed approvalId is a 404 APPROVAL_NOT_FOUND (before the runtime).
    await fails(
      await call(alice, "POST", path("not-an-approval"), { decision: "allow" }),
      404,
      "APPROVAL_NOT_FOUND",
    );
    // Another member cannot answer on this chat: a plain 404.
    await fails(
      await call(bob, "POST", path(okId), { decision: "allow" }),
      404,
      "NOT_FOUND",
    );
    // The run is settled, so there is no pending approval: 404 APPROVAL_NOT_FOUND.
    await fails(
      await call(alice, "POST", path(okId), { decision: "allow" }),
      404,
      "APPROVAL_NOT_FOUND",
    );
  });

  test("a live reply streams only to its owner, in its chat and tenant", async () => {
    gateway.script.push(
      { kind: "reply", text: "Other chat." },
      { kind: "held", before: "Held", after: " reply." },
    );
    const other = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, other);
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const { id } = receipt.chat;
    const runPath = `/runs/${receipt.run.id}/stream`;
    // The same user, signed in to another tenant: another database.
    const aliceElsewhere = await member("alice", otherTenantId);
    assert.ok(aliceElsewhere.userId.equals(alice.userId));
    for (const [who, chatId] of [
      [bob, id],
      [dave, id],
      [aliceElsewhere, id],
      [alice, other.chat.id],
    ] as const)
      await fails(
        await call(who, "GET", `/chats/${chatId}${runPath}`),
        404,
        "NOT_FOUND",
      );
    await fails(
      await call(bob, "POST", `/chats/${id}/runs/${receipt.run.id}/stop`),
      404,
      "NOT_FOUND",
    );
    await gateway.waitForRequests(2);
    gateway.release();
    assert.equal(textOf(await finish(alice, receipt)), "Held reply.");
  });

  // Runs a store call as a request would, returning its MongoDB call count.
  async function counted<T>(
    work: () => Promise<T>,
  ): Promise<{ value: T; calls: number }> {
    let timing: RequestTiming | undefined;
    let pending!: Promise<T>;
    const res = {
      headersSent: false,
      setHeader: () => res,
      writeHead: () => res,
    };
    serverTiming(
      {} as ExpressRequest,
      res as unknown as ExpressResponse,
      () => {
        timing = currentTiming();
        pending = work();
      },
    );
    const value = await pending;
    const calls = /db;dur=[\d.]+;desc="MongoDB \((\d+) calls?\)"/.exec(
      timing?.header() ?? "",
    )?.[1];
    return { value, calls: Number(calls) };
  }

  // A message saved with no reader in this process, as after a crash.
  async function unread(send: () => Promise<Response>): Promise<Receipt> {
    const executor = running.app.get(RunExecutor);
    const begin = executor.begin.bind(executor);
    executor.begin = () => undefined;
    try {
      return await json<Receipt>(await send(), 202);
    } finally {
      executor.begin = begin;
    }
  }

  test("the runtime's acceptance is saved in one call and never replaces a thread", async () => {
    const store = running.app.get(ChatStore);
    const db = database.tenantDb(DEFAULT_TENANT_DB_NAME);
    const receipt = await unread(() => startChat(alice));
    const chatId = ObjectId.createFromHexString(receipt.chat.id);
    const runId = ObjectId.createFromHexString(receipt.run.id);

    const first = await counted(() =>
      store.markAccepted(
        DEFAULT_TENANT_DB_NAME,
        chatId,
        runId,
        "thread-1",
        "turn-1",
      ),
    );
    assert.equal(first.calls, 1);
    const run = await db.collection<RunDoc>(RUNS_COLLECTION).findOne({
      _id: runId,
    });
    assert.equal(run?.status, "running");
    assert.equal(run?.threadId, "thread-1");
    assert.ok(run?.timings.dispatchedAt);
    const chats = db.collection<ChatDoc>(CHATS_COLLECTION);
    assert.deepEqual((await chats.findOne({ _id: chatId }))?.runtime, {
      threadId: "thread-1",
      state: "ready",
    });

    // A repeat with another thread changes neither.
    await store.markAccepted(
      DEFAULT_TENANT_DB_NAME,
      chatId,
      runId,
      "thread-2",
      "turn-2",
    );
    assert.equal(
      (await chats.findOne({ _id: chatId }))?.runtime.threadId,
      "thread-1",
    );
  });

  test("a reply is saved in one write plus the commit; a repeat or late save changes nothing", async () => {
    const store = running.app.get(ChatStore);
    const chats = database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION);
    const outcome: Settlement = {
      status: "completed",
      error: null,
      items: [
        { type: "reply", itemId: "a", text: "One.", completed: true },
        { type: "reply", itemId: "blank", text: "  ", completed: true },
        { type: "reply", itemId: "b", text: "Two.", completed: true },
      ],
      usage: null,
      threadId: null,
      turnId: null,
      threadLost: false,
    };
    const first = await unread(() => startChat(alice));
    const chatId = ObjectId.createFromHexString(first.chat.id);
    const run1 = ObjectId.createFromHexString(first.run.id);

    // The run, then the chat and reply in one call, then the commit.
    const saved = await counted(() =>
      store.settle(DEFAULT_TENANT_DB_NAME, chatId, run1, 2, outcome),
    );
    assert.equal(saved.calls, 3);
    assert.deepEqual(
      saved.value.messages.map((m) => [m.seq, m.text]),
      [
        [2, "One."],
        [3, "Two."],
      ],
    );
    let chat = await chats.findOne({ _id: chatId });
    assert.equal(chat?.nextSeq, 4);
    assert.equal(chat?.activeRun, null);

    // A repeat returns what was saved and writes nothing.
    const again = await store.settle(DEFAULT_TENANT_DB_NAME, chatId, run1, 2, {
      ...outcome,
      status: "failed",
    });
    assert.equal(again.run.status, "completed");
    assert.deepEqual(
      again.messages.map((m) => m._id.toHexString()),
      saved.value.messages.map((m) => m._id.toHexString()),
    );

    // A late save of the first run never releases the next one's claim.
    const second = await unread(() =>
      call(alice, "POST", `/chats/${first.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "Next",
      }),
    );
    assert.equal(second.message.seq, 4);
    await store.settle(DEFAULT_TENANT_DB_NAME, chatId, run1, 2, outcome);
    chat = await chats.findOne({ _id: chatId });
    assert.equal(chat?.activeRun?.runId.toHexString(), second.run.id);
    assert.equal(chat?.nextSeq, 5);

    // A chat not in the state its unsettled run implies (hand-edited) is
    // still saved, after its last message, and released.
    await chats.updateOne({ _id: chatId }, { $set: { nextSeq: 9 } });
    const run2 = ObjectId.createFromHexString(second.run.id);
    const moved = await store.settle(
      DEFAULT_TENANT_DB_NAME,
      chatId,
      run2,
      5,
      outcome,
    );
    assert.deepEqual(
      moved.messages.map((m) => m.seq),
      [9, 10],
    );
    chat = await chats.findOne({ _id: chatId });
    assert.equal(chat?.activeRun, null);
    assert.equal(chat?.nextSeq, 11);
    const body = await getChat(alice, first.chat.id);
    assert.deepEqual(
      body.messages.map((m) => m.seq),
      [1, 2, 3, 4, 9, 10],
    );
  });

  test("helper agents are saved as tool rows, once, and read back through the API", async () => {
    const store = running.app.get(ChatStore);
    const usage = {
      input: 20,
      cached: 0,
      cacheWrite: 0,
      output: 10,
      reasoning: 0,
    };
    const outcome: Settlement = {
      status: "completed",
      error: null,
      items: [
        {
          type: "reply",
          itemId: "a",
          text: "Globex is at risk.",
          completed: true,
        },
      ],
      agents: [
        {
          agentId: "th-1",
          path: "/root/crm",
          status: "completed",
          preview: "live only",
          result: "Globex stalled 21 days.",
          usage,
        },
        { agentId: "th-2", path: "/root/email", status: "running" },
      ],
      usage: null,
      threadId: null,
      turnId: null,
      threadLost: false,
    };
    const first = await unread(() => startChat(alice));
    const chatId = ObjectId.createFromHexString(first.chat.id);
    const runId = ObjectId.createFromHexString(first.run.id);
    const saved = await store.settle(
      DEFAULT_TENANT_DB_NAME,
      chatId,
      runId,
      2,
      outcome,
    );
    assert.deepEqual(
      saved.messages.map((m) => [m.seq, m.role, m.runtimeItemId]),
      [
        [2, "tool", "agent:th-1"],
        [3, "tool", "agent:th-2"],
        [4, "assistant", "a"],
      ],
    );
    // A repeated save writes no second set of rows.
    const again = await store.settle(
      DEFAULT_TENANT_DB_NAME,
      chatId,
      runId,
      2,
      outcome,
    );
    assert.equal(again.messages.length, 3);
    const stored = await database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection(MESSAGES_COLLECTION)
      .countDocuments({ runId, runtimeItemId: /^agent:/ });
    assert.equal(stored, 2);
    assert.equal((await runDoc(first.run.id))?.helperCount, 2);

    const body = await getChat(alice, first.chat.id);
    const rows = body.messages.filter((m) => m.role === "tool") as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(rows[0]!.agent, {
      path: "/root/crm",
      status: "completed",
      result: "Globex stalled 21 days.",
      usage,
    });
    // Still running at settle means stopped with the run.
    assert.deepEqual(rows[1]!.agent, {
      path: "/root/email",
      status: "stopped",
    });
    // The live preview never reaches storage or the API.
    assert.ok(!JSON.stringify(body).includes("live only"));
    assert.ok(!JSON.stringify(rows).includes("runtimeItemId"));
  });

  test("a disabled model makes its chats read-only; an archived agent does not", async () => {
    const agent = await json<{ agent: { id: string; revision: number } }>(
      await call(alice, "POST", "/agents", {
        clientRequestId: `req-${Date.now()}`,
        scope: "personal",
        name: "Writer",
        description: "Writes.",
        modelId,
        look: 1,
        tint: "mint",
      }),
      201,
    );
    const receipt = await json<Receipt>(
      await startChat(alice, "hi", agent.agent.id),
      202,
    );
    await finish(alice, receipt);
    await json(
      await call(alice, "POST", `/agents/${agent.agent.id}/archive`),
      200,
    );
    const cont = await json<Receipt>(
      await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "still here?",
      }),
      202,
    );
    await finish(alice, cont);
    // A new chat with the archived agent is refused.
    await fails(await startChat(alice, "hi", agent.agent.id), 404, "NOT_FOUND");

    await operator.setModelEnabled({
      operator: "ops",
      slug: "claude-sonnet",
      enabled: false,
    });
    await fails(
      await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "and now?",
      }),
      409,
      "CHAT_READ_ONLY",
    );
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.chat.readOnly, "MODEL_UNAVAILABLE");
    assert.equal(body.messages.length, 4);
  });

  test("list, rename and archive", async () => {
    const a = await json<Receipt>(await startChat(alice, "Alpha"), 202);
    await finish(alice, a);
    const b = await json<Receipt>(await startChat(alice, "Beta"), 202);
    await finish(alice, b);
    const list = await json<{ chats: Array<{ id: string; title: string }> }>(
      await call(alice, "GET", "/chats"),
      200,
    );
    assert.deepEqual(
      list.chats.map((c) => c.title),
      ["Beta", "Alpha"],
    );
    const renamed = await json<{ chat: { title: string } }>(
      await call(alice, "PATCH", `/chats/${a.chat.id}`, {
        title: "  Renamed  ",
      }),
      200,
    );
    assert.equal(renamed.chat.title, "Renamed");
    await json(await call(alice, "POST", `/chats/${a.chat.id}/archive`), 200);
    const active = await json<{ chats: Array<{ id: string }> }>(
      await call(alice, "GET", "/chats"),
      200,
    );
    assert.deepEqual(
      active.chats.map((c) => c.id),
      [b.chat.id],
    );
    const archived = await json<{ chats: Array<{ id: string }> }>(
      await call(alice, "GET", "/chats?status=archived"),
      200,
    );
    assert.deepEqual(
      archived.chats.map((c) => c.id),
      [a.chat.id],
    );
    await fails(
      await call(alice, "POST", `/chats/${a.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "hi",
      }),
      409,
      "CHAT_READ_ONLY",
    );
  });

  test("invalid input is refused before anything is saved", async () => {
    const cases: unknown[] = [
      { agentId: builtinId, clientMessageId: clientId(), text: "   " },
      {
        agentId: builtinId,
        clientMessageId: clientId(),
        text: "x".repeat(32_001),
      },
      {
        agentId: builtinId,
        clientMessageId: clientId(),
        text: "bad \u202e bidi",
      },
      { agentId: builtinId, clientMessageId: "short", text: "hi" },
      { agentId: "nope", clientMessageId: clientId(), text: "hi" },
      { agentId: builtinId, clientMessageId: clientId(), text: "hi", extra: 1 },
    ];
    for (const body of cases)
      await fails(
        await call(alice, "POST", "/chats", body),
        400,
        "BAD_REQUEST",
      );
    await fails(
      await startChat(alice, "hi", new ObjectId().toHexString()),
      404,
      "NOT_FOUND",
    );
    const list = await json<{ chats: unknown[] }>(
      await call(alice, "GET", "/chats"),
      200,
    );
    assert.equal(list.chats.length, 0);
  });

  test("a platform restart mid-reply recovers the run without resending it", async () => {
    gateway.script.push({
      kind: "held",
      before: "Before restart",
      after: ", after restart.",
    });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await gateway.waitForRequests(1);
    await sleep(300);
    // The process goes away without settling; its lease would lapse.
    await running.app.get(RunExecutor).drain(0);
    await running.close();
    await boot();
    const chats = database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION);
    await chats.updateOne(
      { _id: ObjectId.createFromHexString(receipt.chat.id) },
      { $set: { "activeRun.leaseExpiresAt": new Date(0) } },
    );
    const opened = await getChat(alice, receipt.chat.id);
    assert.equal(opened.chat.activeRunId, receipt.run.id);
    gateway.release();
    const events = await finish(alice, receipt);
    assert.equal(
      savedOf(events).messages[0]?.text,
      "Before restart, after restart.",
    );
    assert.equal(gateway.requests.length, 1, "the message was not resent");
  });

  test("a reply that cannot be saved keeps the chat locked until recovery saves it", async () => {
    const store = running.app.get(ChatStore);
    const realSettle = store.settle.bind(store);
    store.settleRetryDelaysMs = [20, 20];
    let failures = 0;
    store.settle = async () => {
      failures++;
      throw new Error("simulated database failure");
    };
    try {
      gateway.script.push({ kind: "reply", text: "Saved later." });
      const receipt = await json<Receipt>(await startChat(alice), 202);
      const events = await finish(alice, receipt);
      assert.equal(events.at(-1)?.type, "save_failed");
      assert.equal(failures, 3);
      // Never a false success, and no new turn on top of unsaved state.
      const locked = await getChat(alice, receipt.chat.id);
      assert.equal(locked.chat.activeRunId, receipt.run.id);
      await fails(
        await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
          clientMessageId: clientId(),
          text: "next",
        }),
        409,
        "CHAT_BUSY",
      );

      // This process gave the run up, so the next access recovers it
      // without waiting for the lease.
      store.settle = realSettle;
      await getChat(alice, receipt.chat.id);
      const recovered = savedOf(await finish(alice, receipt));
      assert.equal(recovered.messages[0]?.text, "Saved later.");
      assert.equal(gateway.requests.length, 1, "not sent twice");
      assert.equal(
        (await getChat(alice, receipt.chat.id)).chat.activeRunId,
        null,
      );
    } finally {
      store.settle = realSettle;
      store.settleRetryDelaysMs = [500];
    }
  });

  test("recovery never sends a message the runtime has no trace of", async () => {
    const executor = running.app.get(RunExecutor);
    const begin = executor.begin.bind(executor);
    // The process dies between saving the message and posting it.
    executor.begin = () => undefined;
    let receipt: Receipt;
    try {
      receipt = await json<Receipt>(
        await startChat(alice, "NEVER_POSTED"),
        202,
      );
    } finally {
      executor.begin = begin;
    }
    await database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .updateOne(
        { _id: ObjectId.createFromHexString(receipt.chat.id) },
        { $set: { "activeRun.leaseExpiresAt": new Date(0) } },
      );
    const saved = savedOf(await finish(alice, receipt));
    assert.equal(saved.run.status, "failed");
    assert.equal(saved.run.error?.code, "NOT_SENT");
    assert.equal(gateway.requests.length, 0);
    // The member resends it as a new message.
    const resent = await json<Receipt>(
      await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "NEVER_POSTED",
      }),
      202,
    );
    assert.equal(savedOf(await finish(alice, resent)).run.status, "completed");
    assert.equal(gateway.requests.length, 1);
  });

  test("a stop racing the end of a reply settles exactly once", async () => {
    gateway.script.push({ kind: "reply", text: "Quick reply here.", chunk: 2 });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    const res = await stream(alice, receipt.chat.id, receipt.run.id);
    const stops: Promise<Response>[] = [];
    const events = await readStream(res, (event) => {
      if (event.type === "delta" && stops.length < 3)
        stops.push(
          call(
            alice,
            "POST",
            `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stop`,
          ),
        );
    });
    for (const stop of await Promise.all(stops))
      assert.ok([202, 503].includes(stop.status), String(stop.status));
    const saved = savedOf(events);
    assert.ok(["stopped", "completed"].includes(saved.run.status));
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.chat.activeRunId, null);
    assert.ok(body.messages.filter((m) => m.role === "assistant").length <= 1);
    assert.equal(body.runs[0]?.status, saved.run.status);
  });

  test("an adapter shutdown fails the reply clearly; the chat resumes after", async () => {
    gateway.script.push({
      kind: "held",
      before: "Interrupted",
      after: " never",
    });
    const receipt = await json<Receipt>(await startChat(alice, "FIRST"), 202);
    await gateway.waitForRequests(1);
    await sleep(300);
    await adapter.stop();
    const saved = savedOf(await finish(alice, receipt));
    assert.equal(saved.run.status, "failed");
    assert.equal(saved.run.error?.code, "RUNTIME_SHUTDOWN");
    assert.equal(saved.messages[0]?.text, "Interrupted");
    gateway.release();
    await adapter.start();
    const followUp = await json<Receipt>(
      await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
        clientMessageId: clientId(),
        text: "SECOND",
      }),
      202,
    );
    assert.equal(
      savedOf(await finish(alice, followUp)).run.status,
      "completed",
    );
    assert.match(JSON.stringify(gateway.requests.at(-1)!.body), /FIRST/);
  });

  // ---- Slices 9–10: continuation, stop, revocation and recovery ----

  async function until(
    what: string,
    check: () => boolean | Promise<boolean>,
    ms = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await sleep(50);
    }
  }

  const chatsCollection = () =>
    database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION);
  const chatDoc = (id: string) =>
    chatsCollection().findOne({ _id: ObjectId.createFromHexString(id) });
  const runDoc = (id: string) =>
    database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<RunDoc>(RUNS_COLLECTION)
      .findOne({ _id: ObjectId.createFromHexString(id) });
  const lapse = (id: string) =>
    chatsCollection().updateOne(
      { _id: ObjectId.createFromHexString(id) },
      { $set: { "activeRun.leaseExpiresAt": new Date(0) } },
    );
  const chatFolder = (receipt: Receipt) =>
    join(adapter.stateDir, "t", tenantId.toHexString(), "c", receipt.chat.id);
  const followUp = (who: Member, chatId: string, text: string) =>
    call(who, "POST", `/chats/${chatId}/messages`, {
      clientMessageId: clientId(),
      text,
    });

  test("a follow-up after the runtime restarts resumes the same thread from its saved home", async () => {
    gateway.script.push(
      { kind: "reply", text: "REMEMBER_42 noted." },
      { kind: "reply", text: "It was 42." },
    );
    const first = await json<Receipt>(
      await startChat(alice, "Remember the number REMEMBER_42"),
      202,
    );
    await finish(alice, first);
    const threadId = (await chatDoc(first.chat.id))?.runtime.threadId;
    assert.ok(threadId);

    // The runtime process dies with nothing in memory; its disk stays.
    await adapter.stop(true);
    await assert.rejects(
      fetch(`${adapter.url}/health`, { signal: AbortSignal.timeout(2_000) }),
      TypeError,
      "a hard stop ends the adapter rather than just its launcher",
    );
    await adapter.start();
    const second = await json<Receipt>(
      await followUp(alice, first.chat.id, "Which number?"),
      202,
    );
    assert.equal(savedOf(await finish(alice, second)).run.status, "completed");
    const context = JSON.stringify(gateway.requests[1]!.body);
    assert.match(context, /REMEMBER_42 noted\./);
    assert.match(context, /Which number\?/);
    assert.equal((await chatDoc(first.chat.id))?.runtime.threadId, threadId);
  });

  test("lost runtime state makes the chat read-only and never starts a replacement thread", async () => {
    const first = await json<Receipt>(await startChat(alice, "Keep this"), 202);
    await finish(alice, first);
    await adapter.stop(true);
    await rm(chatFolder(first), { recursive: true, force: true });
    await adapter.start();

    const lost = await json<Receipt>(
      await followUp(alice, first.chat.id, "Still there?"),
      202,
    );
    const saved = savedOf(await finish(alice, lost));
    assert.equal(saved.run.status, "failed");
    assert.equal(saved.run.error?.code, "THREAD_LOST");
    assert.equal(gateway.requests.length, 1, "no new thread was asked for");
    await fails(
      await followUp(alice, first.chat.id, "Again?"),
      409,
      "CHAT_READ_ONLY",
    );
    // The saved history is still there to read.
    const body = await getChat(alice, first.chat.id);
    assert.equal(body.chat.readOnly, "THREAD_LOST");
    assert.deepEqual(body.messages.map((m) => [m.role, m.text]).slice(0, 3), [
      ["user", "Keep this"],
      ["assistant", "Hello from the model."],
      ["user", "Still there?"],
    ]);
  });

  test("an unreadable thread record fails the reply without replacing the thread", async () => {
    const first = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, first);
    const threadId = (await chatDoc(first.chat.id))?.runtime.threadId;
    await adapter.stop(true);
    await writeFile(join(chatFolder(first), "chat.json"), "{not json");
    await adapter.start();
    const next = await json<Receipt>(
      await followUp(alice, first.chat.id, "hello?"),
      202,
    );
    const saved = savedOf(await finish(alice, next));
    assert.equal(saved.run.status, "failed");
    assert.ok(saved.run.error?.message);
    assert.equal(gateway.requests.length, 1);
    const chat = await chatDoc(first.chat.id);
    assert.equal(chat?.activeRun, null);
    assert.equal(chat?.runtime.threadId, threadId);
    assert.notEqual(chat?.runtime.state, "lost");
  });

  test("a reply whose acceptance write failed still records the chat's thread", async () => {
    const store = running.app.get(ChatStore);
    const markAccepted = store.markAccepted.bind(store);
    store.markAccepted = () => Promise.reject(new Error("simulated failure"));
    let receipt: Receipt;
    try {
      receipt = await json<Receipt>(await startChat(alice), 202);
      assert.equal(
        savedOf(await finish(alice, receipt)).run.status,
        "completed",
      );
    } finally {
      store.markAccepted = markAccepted;
    }
    const chat = await chatDoc(receipt.chat.id);
    assert.ok(chat?.runtime.threadId, "the settle recorded the thread");
    assert.equal(chat?.runtime.state, "ready");
    const run = await database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<RunDoc>(RUNS_COLLECTION)
      .findOne({ _id: ObjectId.createFromHexString(receipt.run.id) });
    assert.equal(chat?.runtime.threadId, run?.threadId);
  });

  test("stop before any text settles as stopped with nothing saved, and the chat goes on", async () => {
    gateway.script.push({ kind: "stall", text: "too late" });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await until("the model was called", () => gateway.requests.length === 1);
    const res = await stream(alice, receipt.chat.id, receipt.run.id);
    const stopped = await call(
      alice,
      "POST",
      `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stop`,
    );
    assert.equal(stopped.status, 202);
    const events = await readStream(res);
    const saved = savedOf(events);
    assert.equal(saved.run.status, "stopped");
    assert.equal(saved.messages.length, 0);
    assert.equal(textOf(events), "");
    gateway.release();
    const next = await json<Receipt>(
      await followUp(alice, receipt.chat.id, "try again"),
      202,
    );
    assert.equal(savedOf(await finish(alice, next)).run.status, "completed");
  });

  test("a disabled built-in stops new replies in its chats; history stays readable", async () => {
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, receipt);
    await operator.setBuiltinAgentEnabled({
      operator: "ops",
      slug: "general",
      enabled: false,
    });
    await fails(
      await followUp(alice, receipt.chat.id, "more?"),
      409,
      "CHAT_READ_ONLY",
    );
    await fails(await startChat(alice), 404, "NOT_FOUND");
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.chat.readOnly, "AGENT_UNAVAILABLE");
    assert.equal(body.messages.length, 2);
    assert.equal(gateway.requests.length, 1);
  });

  test("removed access blocks new replies and reads; the saved chat is kept for its owner", async () => {
    const receipt = await json<Receipt>(await startChat(alice, "PRIVATE"), 202);
    await finish(alice, receipt);
    const memberships = database.catalog().collection(MEMBERSHIPS_COLLECTION);
    await memberships.updateOne(
      { userId: alice.userId, tenantId },
      { $set: { status: "removed" } },
    );
    // The next token the app gets carries no tenant, so the guard checks
    // the membership itself.
    const sessions = running.app.get(SessionsService);
    const renewed = await sessions.refresh(
      alice.refreshCredential,
      new Date(),
      tenantId,
    );
    assert.equal(renewed.tenant, undefined);
    const removed: Member = {
      ...alice,
      token: renewed.accessToken,
      refreshCredential: renewed.refreshCredential,
    };
    await fails(
      await followUp(removed, receipt.chat.id, "hi"),
      403,
      "FORBIDDEN",
    );
    await fails(await startChat(removed), 403, "FORBIDDEN");
    const read = await call(removed, "GET", `/chats/${receipt.chat.id}`);
    assert.equal(read.status, 403);
    assert.doesNotMatch(await read.text(), /PRIVATE/);
    assert.equal(gateway.requests.length, 1);

    // Nothing was erased: restored access shows the same history.
    await memberships.updateOne(
      { userId: alice.userId, tenantId },
      { $set: { status: "active" } },
    );
    const restored = await sessions.refresh(
      removed.refreshCredential,
      new Date(),
      tenantId,
    );
    const body = await getChat(
      { ...alice, token: restored.accessToken },
      receipt.chat.id,
    );
    assert.equal(body.messages[0]?.text, "PRIVATE");
    assert.equal(body.messages.length, 2);
  });

  test("closing the browser before text, during text or after completion loses and repeats nothing", async () => {
    const points = ["before-text", "during-text", "after-completed"] as const;
    for (const point of points) {
      gateway.script.push(
        point === "before-text"
          ? { kind: "stall", text: "Whole reply, once." }
          : { kind: "held", before: "Whole reply,", after: " once." },
      );
      const receipt = await json<Receipt>(await startChat(alice, point), 202);
      await until(
        "the model was called",
        () => gateway.requests.length > points.indexOf(point),
      );
      const abort = new AbortController();
      const res = await stream(
        alice,
        receipt.chat.id,
        receipt.run.id,
        abort.signal,
      );
      if (point === "before-text") {
        abort.abort();
        gateway.release();
      } else
        await readStream(res, (event) => {
          // Text arrives as a delta, or already in the snapshot when the
          // stream opens after the first delta reached the platform.
          const text =
            event.type === "delta" ||
            (event.type === "snapshot" &&
              (event.data.items as unknown[]).length > 0);
          if (point === "during-text" && text) abort.abort();
          if (point === "after-completed" && event.type === "completed")
            abort.abort();
          if (point === "after-completed" && text) gateway.release();
        }).catch(() => undefined);
      gateway.release();
      const events = await finish(alice, receipt);
      assert.equal(events[0]?.type, "snapshot", point);
      assert.equal(textOf(events), "Whole reply, once.", point);
      const body = await getChat(alice, receipt.chat.id);
      assert.deepEqual(
        body.messages.map((m) => m.text),
        [point, "Whole reply, once."],
        point,
      );
    }
  });

  test("the recovery sweep saves a reply whose process died, without anyone opening the chat", async () => {
    gateway.script.push({
      kind: "held",
      before: "Started before the crash",
      after: ", saved by the sweep.",
    });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await until("the model was called", () => gateway.requests.length === 1);
    await sleep(300);
    await running.app.get(RunExecutor).drain(0);
    await running.close();
    await boot({ recoverySweepMs: 200 });
    // Still within its lease: the sweep leaves it to its holder.
    await running.app.get(RecoverySweep).runOnce();
    assert.equal(
      running.app
        .get(RunExecutor)
        .isLive(ObjectId.createFromHexString(receipt.run.id)),
      false,
    );

    await lapse(receipt.chat.id);
    gateway.release();
    // The scheduled sweep finds it; nobody calls the API.
    await until(
      "the sweep saved the reply",
      async () => (await chatDoc(receipt.chat.id))?.activeRun === null,
    );
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(
      body.messages[1]?.text,
      "Started before the crash, saved by the sweep.",
    );
    assert.equal(gateway.requests.length, 1, "not resent");
    await running.close();
    await boot();
  });

  test("a lapsed claim is taken over by one recoverer only", async () => {
    const store = running.app.get(ChatStore);
    const receipt = await unread(() => startChat(alice));
    const chatId = ObjectId.createFromHexString(receipt.chat.id);
    const runId = ObjectId.createFromHexString(receipt.run.id);
    const seen = (await chatDoc(receipt.chat.id))!.activeRun!.leaseExpiresAt;
    const takes = await Promise.all(
      [1, 2, 3].map(() =>
        store.takeOverLease(DEFAULT_TENANT_DB_NAME, chatId, runId, seen),
      ),
    );
    assert.deepEqual(takes.filter(Boolean).length, 1, JSON.stringify(takes));
    // The sweep then finds nothing lapsed for it.
    assert.equal(
      (await store.lapsedChats(DEFAULT_TENANT_DB_NAME, new Date(), 10)).length,
      0,
    );
    await lapse(receipt.chat.id);
    await running.app.get(RecoverySweep).runOnce();
    const saved = savedOf(await finish(alice, receipt));
    assert.equal(saved.run.status, "failed");
    assert.equal(saved.run.error?.code, "NOT_SENT");
  });

  test("a completion the platform never saw is recovered from the runtime's history", async () => {
    gateway.script.push({
      kind: "held",
      before: "Finished while",
      after:
        " the platform was down.\n\n[truex-suggestions]\nshape: explain; stage: none\nact: Recovered row\n[/truex-suggestions]",
    });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await until("the model was called", () => gateway.requests.length === 1);
    await sleep(300);
    // The platform goes away; the turn finishes in the runtime unobserved.
    await running.app.get(RunExecutor).drain(0);
    await running.close();
    gateway.release();
    const history = async () => {
      const res = await fetch(
        `${adapter.url}/v1/chats/${receipt.chat.id}/history?tenantId=${tenantId.toHexString()}`,
        { headers: { authorization: `Bearer ${ADAPTER_TOKEN}` } },
      );
      return ((await res.json()) as { turns: Array<{ status: string }> }).turns;
    };
    await until("the turn completed in the runtime", async () =>
      (await history()).some((t) => t.status === "completed"),
    );
    // The runtime restarts too, so the run's events are gone: only its
    // saved history knows the outcome.
    await adapter.stop();
    await adapter.start();
    await boot();
    await lapse(receipt.chat.id);
    await running.app.get(RecoverySweep).runOnce();
    await until(
      "recovery saved the reply",
      async () => (await chatDoc(receipt.chat.id))?.activeRun === null,
    );
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.runs[0]?.status, "completed");
    assert.equal(
      body.messages[1]?.text,
      "Finished while the platform was down.",
    );
    assert.equal(body.runs[0]?.followUps?.items[0]?.text, "Recovered row");
    const raw = await runDoc(receipt.run.id);
    assert.equal(raw?.followUps?.status, "ok");
    assert.equal(gateway.requests.length, 1, "not resent");
  });

  // Goal runs (tasks/goal-mode-todo.md, Task 8). Until the GoalWatcher
  // (Task 9) reads the adapter's chat stream, these tests read it and begin
  // each goal run as the watcher will.
  const GOAL_OBJECTIVE = "GOAL_OBJECTIVE: write the quarterly summary.";
  // The model marks the goal complete; Codex then asks it once more.
  const COMPLETE_GOAL = {
    kind: "call",
    name: "update_goal",
    args: { status: "complete" },
  } as const;

  // A goal chat whose first reply is saved, with its goal made active.
  // Codex then starts the goal's turns by itself.
  async function activeGoalChat(
    settings = {
      presets: [100_000, 300_000, 500_000] as [number, number, number],
      maxTokenBudget: 1_000_000,
      maxActive: 10,
    },
  ) {
    await operator.setTenantGoals({
      operator: "ops",
      tenantId,
      goals: settings,
    });
    const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
    const bodies: StartRunBody[] = [];
    const original = client.startRun.bind(client);
    client.startRun = (body, signal) => {
      bodies.push(body);
      return original(body, signal);
    };
    let receipt: Receipt;
    try {
      receipt = await json<Receipt>(
        await startChat(alice, "FIRST_QUESTION"),
        202,
      );
      await finish(alice, receipt);
    } finally {
      client.startRun = original;
    }
    const {
      runId: _run,
      tenantId: _tenant,
      chatId: _chat,
      input: _input,
      goals,
      ...context
    } = bodies[0]!;
    assert.ok(goals);
    const threadId = (await chatDoc(receipt.chat.id))!.runtime.threadId;
    const ref = { tenantId: tenantId.toHexString(), chatId: receipt.chat.id };
    return {
      receipt,
      ref,
      activate: () =>
        client.setGoal(ref, {
          goals,
          status: "active",
          objective: GOAL_OBJECTIVE,
          tokenBudget: 100_000,
          run: { ...context, threadId },
        }),
    };
  }

  // Reads the chat's adapter stream and begins every goal run it announces,
  // trying again while the previous run is still being saved. The first is
  // begun by `racers` callers at once.
  function attachGoalRuns(ref: ChatRef, racers = 1) {
    const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
    const chats = running.app.get(ChatsService);
    const tenant = { tenantId, dbName: DEFAULT_TENANT_DB_NAME };
    const chatId = ObjectId.createFromHexString(ref.chatId);
    const controller = new AbortController();
    const started: Array<{ runId: string; turnId: string }> = [];
    const firstAnswers: string[] = [];
    const reading = (async () => {
      for await (const event of client.chatEvents(
        ref,
        null,
        controller.signal,
      )) {
        if (event.type !== "run.started") continue;
        const begin = () =>
          chats.beginGoalRun(
            tenant,
            chatId,
            ObjectId.createFromHexString(event.runId),
            event.turnId,
          );
        let answers = await Promise.all(
          Array.from({ length: started.length ? 1 : racers }, begin),
        );
        while (answers.every((answer) => answer === "busy")) {
          await sleep(50);
          answers = [await begin()];
        }
        if (!started.length) firstAnswers.push(...answers);
        started.push({ runId: event.runId, turnId: event.turnId });
      }
    })().catch(() => undefined);
    return {
      started,
      firstAnswers,
      async close() {
        controller.abort();
        await reading;
      },
    };
  }

  test("a goal's turns are saved as goal runs after the chat's last message, with no member message; a repeated begin saves once", async () => {
    const { receipt, ref, activate } = await activeGoalChat();
    const attached = attachGoalRuns(ref, 3);
    gateway.script.push(
      { kind: "reply", text: "STEP_ONE" },
      { kind: "reply", text: "STEP_TWO" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    await activate();
    await until(
      "three goal runs were saved",
      async () =>
        attached.started.length === 3 &&
        (await chatDoc(receipt.chat.id))?.activeRun === null,
      30_000,
    );
    await attached.close();
    // Three callers began the first at once: one claimed and read it.
    assert.deepEqual([...attached.firstAnswers].sort(), [
      "exists",
      "exists",
      "started",
    ]);
    const chats = running.app.get(ChatsService);
    const [first] = attached.started;
    assert.equal(
      await chats.beginGoalRun(
        { tenantId, dbName: DEFAULT_TENANT_DB_NAME },
        ObjectId.createFromHexString(receipt.chat.id),
        ObjectId.createFromHexString(first!.runId),
        first!.turnId,
      ),
      "exists",
    );

    const body = await getChat(alice, receipt.chat.id);
    // One member message; every goal reply follows the last message.
    assert.deepEqual(
      body.messages.map((m) => [m.seq, m.role]),
      [
        [1, "user"],
        [2, "assistant"],
        [3, "assistant"],
        [4, "assistant"],
        [5, "assistant"],
      ],
    );
    assert.deepEqual(
      body.messages.slice(2).map((m) => [m.text, m.runId]),
      [
        ["STEP_ONE", attached.started[0]!.runId],
        ["STEP_TWO", attached.started[1]!.runId],
        ["GOAL_DONE", attached.started[2]!.runId],
      ],
    );
    // In no particular order: goal run IDs are digests, not times.
    const byId = (a: unknown[], b: unknown[]) =>
      String(a[0]).localeCompare(String(b[0]));
    assert.deepEqual(
      body.runs
        .map((run) => [run.id, run.status, run.trigger ?? null])
        .sort(byId),
      [
        [receipt.run.id, "completed", null],
        ...attached.started.map((run) => [run.runId, "completed", "goal"]),
      ].sort(byId),
    );
    // A member's run is saved as before: no trigger.
    assert.equal("trigger" in (await runDoc(receipt.run.id))!, false);
    const threadId = (await chatDoc(receipt.chat.id))!.runtime.threadId;
    for (const { runId, turnId } of attached.started) {
      const raw = (await runDoc(runId))!;
      assert.equal(raw.trigger, "goal");
      assert.equal(raw.turnId, turnId);
      assert.equal(raw.threadId, threadId);
      assert.equal("userMessageId" in raw, false);
      assert.equal("clientMessageId" in raw, false);
    }
    assert.equal(
      await database
        .tenantDb(DEFAULT_TENANT_DB_NAME)
        .collection(RUNS_COLLECTION)
        .countDocuments({ chatId: ObjectId.createFromHexString(ref.chatId) }),
      4,
    );
    // The browser reads a goal run like any other.
    const saved = savedOf(
      await readStream(await stream(alice, receipt.chat.id, first!.runId)),
    );
    assert.deepEqual(
      saved.messages.map((m) => m.text),
      ["STEP_ONE"],
    );
  });

  test("a goal run never claims a chat another run holds, or one that changed since it was read, and saves nothing then", async () => {
    const store = running.app.get(ChatStore);
    const first = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, first);
    const read = (await chatDoc(first.chat.id))!;
    const threadId = read.runtime.threadId!;
    const goalRun = (runId = new ObjectId()) => ({
      runId,
      threadId,
      turnId: "turn-goal",
    });
    // The chat as read before a follow-up was answered: free again, but its
    // seq moved on, so a reply saved from that read would land wrong.
    await finish(
      alice,
      await json<Receipt>(
        await followUp(alice, first.chat.id, "And then?"),
        202,
      ),
    );
    const stale = goalRun();
    assert.equal(
      await store.beginGoalRun(DEFAULT_TENANT_DB_NAME, read, stale),
      "busy",
    );
    // A member's follow-up holds the chat (no reader here).
    await unread(() => followUp(alice, first.chat.id, "And after that?"));
    const held = (await chatDoc(first.chat.id))!;
    const blocked = goalRun();
    assert.equal(
      await store.beginGoalRun(DEFAULT_TENANT_DB_NAME, held, blocked),
      "busy",
    );
    for (const { runId } of [stale, blocked])
      assert.equal(await runDoc(runId.toHexString()), null);
    assert.equal(
      (await chatDoc(first.chat.id))!.activeRun?.runId.equals(
        held.activeRun!.runId,
      ),
      true,
    );
  });

  test("goalRunContext is the chat's next run body without a turn, which the adapter accepts to make the goal active; null without goals or a usable thread", async () => {
    const { receipt, ref } = await activeGoalChat();
    const chats = running.app.get(ChatsService);
    const tenant = { tenantId, dbName: DEFAULT_TENANT_DB_NAME };
    const chatId = ObjectId.createFromHexString(receipt.chat.id);

    // The member's next run body, for comparison.
    const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
    const bodies: StartRunBody[] = [];
    const original = client.startRun.bind(client);
    client.startRun = (body, signal) => {
      bodies.push(body);
      return original(body, signal);
    };
    try {
      gateway.script.push({ kind: "reply", text: "Second." });
      const next = await json<Receipt>(
        await call(alice, "POST", `/chats/${receipt.chat.id}/messages`, {
          clientMessageId: clientId(),
          text: "And then?",
        }),
        202,
      );
      await finish(alice, next);
    } finally {
      client.startRun = original;
    }
    const {
      runId: _run,
      tenantId: _tenant,
      chatId: _chat,
      input: _input,
      goals,
      ...nextRun
    } = bodies[0]!;
    assert.ok(goals);

    const context = await chats.goalRunContext(tenant, chatId);
    assert.ok(context);
    for (const key of ["runId", "tenantId", "chatId", "input", "goals"])
      assert.equal(key in context, false, key);
    assert.deepEqual(context, nextRun);
    assert.equal(
      context.threadId,
      (await chatDoc(receipt.chat.id))!.runtime.threadId,
    );

    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
    const goal = await client.setGoal(ref, {
      goals,
      status: "active",
      objective: GOAL_OBJECTIVE,
      tokenBudget: 100_000,
      run: context,
    });
    assert.equal(goal.status, "active");
    assert.equal(goal.objective, GOAL_OBJECTIVE);
    await client.setGoal(ref, { goals, status: "paused" });

    // A lost thread can't run a goal.
    await chatsCollection().updateOne(
      { _id: chatId },
      { $set: { "runtime.state": "lost" } },
    );
    assert.equal(await chats.goalRunContext(tenant, chatId), null);

    // A chat created without goal settings has none.
    await operator.removeTenantGoals({ operator: "ops", tenantId });
    const plain = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, plain);
    assert.equal(
      await chats.goalRunContext(
        tenant,
        ObjectId.createFromHexString(plain.chat.id),
      ),
      null,
    );
  });

  test("a goal run whose reader died is recovered by the sweep from the runtime's history, never posted", async () => {
    const { receipt, ref, activate } = await activeGoalChat();
    const attached = attachGoalRuns(ref);
    gateway.script.push(
      { kind: "held", before: "GOAL_STEP started", after: " and finished." },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    const from = gateway.requests.length;
    await activate();
    await until(
      "the goal's first turn was begun and called the model",
      () => attached.started.length === 1 && gateway.requests.length > from,
    );
    await sleep(300);
    // The platform goes away mid-turn; the goal finishes in the runtime.
    await attached.close();
    await running.app.get(RunExecutor).drain(0);
    await running.close();
    gateway.release();
    const client = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
    // The held step, the complete call, and the answer Codex asks for after.
    await until(
      "the goal completed in the runtime",
      async () =>
        gateway.requests.length === from + 3 &&
        (await client.getGoal(ref))?.status === "complete",
      30_000,
    );
    await sleep(500);
    const requests = gateway.requests.length;
    assert.equal(requests, from + 3);
    // The runtime restarts too: only its saved history knows the turn.
    await adapter.stop();
    await adapter.start();
    await boot();
    const goalRun = attached.started[0]!;
    await lapse(receipt.chat.id);
    await running.app.get(RecoverySweep).runOnce();
    await until(
      "recovery saved the goal run",
      async () => (await chatDoc(receipt.chat.id))?.activeRun === null,
    );
    const raw = (await runDoc(goalRun.runId))!;
    assert.equal(raw.status, "completed");
    assert.equal(raw.trigger, "goal");
    const body = await getChat(alice, receipt.chat.id);
    assert.deepEqual(
      body.messages.map((m) => [m.seq, m.role, m.text]),
      [
        [1, "user", "FIRST_QUESTION"],
        [2, "assistant", "Hello from the model."],
        [3, "assistant", "GOAL_STEP started and finished."],
      ],
    );
    assert.equal(gateway.requests.length, requests, "nothing posted");
  });

  test("a revoked session or removed membership closes a live stream; the reply is still saved", async () => {
    for (const revoke of ["session", "membership"] as const) {
      const who = await member(`carol-${revoke}`, tenantId);
      gateway.script.push({ kind: "held", before: "Secret", after: " rest." });
      const receipt = await json<Receipt>(await startChat(who), 202);
      const res = await stream(who, receipt.chat.id, receipt.run.id);
      const events = await readStream(res, async (event) => {
        if (event.type !== "delta") return;
        if (revoke === "session")
          await database
            .catalog()
            .collection(SESSIONS_COLLECTION)
            .updateOne(
              { _id: who.sessionId },
              { $set: { revokedAt: new Date(), revokedReason: "logout" } },
            );
        else
          await database
            .catalog()
            .collection(MEMBERSHIPS_COLLECTION)
            .updateOne(
              { userId: who.userId, tenantId },
              { $set: { status: "removed" } },
            );
      });
      assert.deepEqual(events.at(-1), {
        type: "end",
        data: { reason: "reauthenticate" },
      });
      assert.equal(textOf(events), "Secret", revoke);
      gateway.release();
      await until(
        "the reply was saved",
        async () => (await chatDoc(receipt.chat.id))?.activeRun === null,
      );
    }
  });

  // The GoalWatcher (tasks/goal-mode-todo.md, Task 9). Making a goal active
  // through the goal API will record it, claim its slot and watch it (Task
  // 10); until then these tests do that themselves.
  const goalsCollection = () =>
    database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<GoalDoc>(GOALS_COLLECTION);
  const goalOf = (chatId: string) =>
    goalsCollection().findOne({ chatId: ObjectId.createFromHexString(chatId) });
  const goalTenant = () => ({ tenantId, dbName: DEFAULT_TENANT_DB_NAME });
  const goalRunsOf = (chatId: string) =>
    database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<RunDoc>(RUNS_COLLECTION)
      .find({ chatId: ObjectId.createFromHexString(chatId), trigger: "goal" })
      .toArray();
  // The goal turns Codex ran in the chat: history turns with no member
  // message.
  const goalTurnsOf = async (ref: ChatRef) =>
    (await new RuntimeClient(adapter.url, ADAPTER_TOKEN).history(ref)).filter(
      (turn) => turn.clientMessageId === null,
    );

  async function recordGoal(
    app: RunningApp,
    chatId: string,
    goal: RuntimeGoal,
  ) {
    const id = ObjectId.createFromHexString(chatId);
    const ownerId = (await chatDoc(chatId))!.ownerId;
    const store = app.app.get(GoalStore);
    await store.recordUpdate(
      DEFAULT_TENANT_DB_NAME,
      tenantId,
      { chatId: id, ownerId },
      { goal, origin: "user", position: null },
    );
    assert.equal(
      await store.claimSlot(DEFAULT_TENANT_DB_NAME, tenantId, id, 10),
      true,
    );
    return id;
  }

  // A goal Codex completed, with nothing left held: review pending, its slot
  // given back, the chat's summary written, every goal turn saved once.
  async function assertGoalSettled(chatId: string, ref: ChatRef) {
    const goal = (await goalOf(chatId))!;
    assert.equal(goal.goal.status, "complete");
    assert.equal(goal.review, "pending");
    assert.equal(goal.slotHeld, false);
    assert.equal(goal.watch?.owner, "", "the watch was given back");
    const slots = await database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<GoalSlotsDoc>(GOAL_SLOTS_COLLECTION)
      .findOne({ _id: tenantId });
    assert.equal(slots?.total, 0);
    assert.deepEqual((await chatDoc(chatId))?.goal, {
      status: "complete",
      review: "pending",
      rev: goal.rev,
    });
    const runs = await goalRunsOf(chatId);
    const turns = await goalTurnsOf(ref);
    assert.deepEqual(
      runs.map((run) => run.turnId).sort(),
      turns.map((turn) => turn.turnId).sort(),
    );
    for (const run of runs) assert.equal(run.status, "completed");
    return runs;
  }

  const goalTexts = async (chatId: string) =>
    (await getChat(alice, chatId)).messages.slice(2).map((m) => m.text);

  test("with no browser connected, the GoalWatcher saves a three-turn goal as three goal runs; the goal ends complete, review pending, its slot released", async () => {
    const { receipt, ref, activate } = await activeGoalChat();
    gateway.script.push(
      { kind: "reply", text: "STEP_ONE" },
      { kind: "reply", text: "STEP_TWO" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    const chatId = await recordGoal(running, receipt.chat.id, await activate());
    const watcher = running.app.get(GoalWatcher);
    assert.equal(await watcher.watch(goalTenant(), chatId), true);
    await until(
      "the goal ended and its runs were saved",
      async () =>
        (await goalOf(receipt.chat.id))?.goal.status === "complete" &&
        (await chatDoc(receipt.chat.id))?.activeRun === null &&
        (await goalRunsOf(receipt.chat.id)).length === 3 &&
        !watcher.isReading(DEFAULT_TENANT_DB_NAME, chatId),
      30_000,
    );
    assert.equal((await assertGoalSettled(receipt.chat.id, ref)).length, 3);
    assert.deepEqual(await goalTexts(receipt.chat.id), [
      "STEP_ONE",
      "STEP_TWO",
      "GOAL_DONE",
    ]);
  });

  test("a platform restart mid-goal: the sweeps resume it, and no goal turn is lost or saved twice", async () => {
    const { receipt, ref, activate } = await activeGoalChat();
    gateway.script.push(
      { kind: "held", before: "STEP", after: "_ONE" },
      { kind: "reply", text: "STEP_TWO" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    const chatId = await recordGoal(running, receipt.chat.id, await activate());
    assert.equal(
      await running.app.get(GoalWatcher).watch(goalTenant(), chatId),
      true,
    );
    await gateway.waitForRequests(2);
    await until(
      "the first goal run was saved",
      async () => (await goalRunsOf(receipt.chat.id)).length === 1,
    );
    // The platform goes away mid-turn; the rest of the goal runs in the
    // runtime with nobody reading it.
    await running.app.get(RunExecutor).drain(0);
    await running.close();
    gateway.release();
    const runtime = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
    await until(
      "the goal finished in the runtime",
      async () => {
        const turns = await goalTurnsOf(ref);
        return (
          (await runtime.getGoal(ref))?.status === "complete" &&
          turns.length === 3 &&
          turns.every((turn) => turn.status === "completed")
        );
      },
      30_000,
    );
    const requests = gateway.requests.length;
    // The adapter restarts too, so its chat stream cannot replay what was
    // missed: those turns are found only in the thread's history.
    await adapter.stop();
    await adapter.start();
    await boot();
    // As after a crash: the run's claim and the goal's watch lapsed, held by
    // a process that is gone.
    await lapse(receipt.chat.id);
    await goalsCollection().updateOne(
      { chatId },
      {
        $set: { "watch.owner": "crashed", "watch.leaseExpiresAt": new Date(0) },
      },
    );
    await running.app.get(RecoverySweep).runOnce();
    await until(
      "recovery saved the first goal run",
      async () => (await chatDoc(receipt.chat.id))?.activeRun === null,
    );
    // The recovered run's own goal update may already have started the
    // watch (the run-stream hook); otherwise the sweep takes it over.
    await running.app.get(GoalWatcher).runOnce();
    await until(
      "the turns that ran unobserved were saved",
      async () =>
        (await chatDoc(receipt.chat.id))?.activeRun === null &&
        (await goalRunsOf(receipt.chat.id)).length === 3 &&
        (await goalOf(receipt.chat.id))?.goal.status === "complete" &&
        !running.app.get(GoalWatcher).isReading(DEFAULT_TENANT_DB_NAME, chatId),
      30_000,
    );
    assert.equal((await assertGoalSettled(receipt.chat.id, ref)).length, 3);
    assert.deepEqual(await goalTexts(receipt.chat.id), [
      "STEP_ONE",
      "STEP_TWO",
      "GOAL_DONE",
    ]);
    assert.equal(gateway.requests.length, requests, "nothing was resent");
  });

  test("two platform processes never both read one chat's goal; a reader that loses its watch stops and the other's sweep takes over", async () => {
    const { receipt, ref, activate } = await activeGoalChat();
    gateway.script.push(
      { kind: "held", before: "STEP", after: "_ONE" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    const other = await startApp({
      mongodbUri: mongo.getUri(),
      auth,
      chat: {
        adapterUrl: adapter.url,
        adapterToken: ADAPTER_TOKEN,
        gatewayUrl: gateway.url,
        gatewaySecret: GATEWAY_SECRET,
        recoverySweepMs: 0,
        streamHeartbeatMs: 300,
      },
    });
    try {
      const watchers = [
        running.app.get(GoalWatcher),
        other.app.get(GoalWatcher),
      ];
      for (const watcher of watchers) watcher.renewMs = 100;
      const chatId = await recordGoal(
        running,
        receipt.chat.id,
        await activate(),
      );
      const reads = () =>
        watchers.map((w) => w.isReading(DEFAULT_TENANT_DB_NAME, chatId));
      const answers = await Promise.all(
        watchers.map((watcher) => watcher.watch(goalTenant(), chatId)),
      );
      assert.equal(answers.filter(Boolean).length, 1, JSON.stringify(answers));
      const [holder, next] = answers[0]
        ? [watchers[0]!, watchers[1]!]
        : [watchers[1]!, watchers[0]!];
      assert.equal(reads().filter(Boolean).length, 1);
      // While the watch is held, neither sweep takes it.
      assert.deepEqual(
        await Promise.all(watchers.map((watcher) => watcher.runOnce())),
        [0, 0],
      );
      assert.equal(reads().filter(Boolean).length, 1);
      await gateway.waitForRequests(2);
      // The reader's lease lapses and the watch is no longer its own: it
      // stops reading, and gives nothing back that it no longer holds.
      await goalsCollection().updateOne(
        { chatId },
        {
          $set: { "watch.owner": "gone", "watch.leaseExpiresAt": new Date(0) },
        },
      );
      await until(
        "the old reader stopped",
        () => !holder.isReading(DEFAULT_TENANT_DB_NAME, chatId),
      );
      assert.equal(await next.runOnce(), 1);
      assert.equal(next.isReading(DEFAULT_TENANT_DB_NAME, chatId), true);
      assert.equal(holder.isReading(DEFAULT_TENANT_DB_NAME, chatId), false);
      assert.equal((await goalOf(receipt.chat.id))?.watch?.owner, next.owner);
      gateway.release();
      await until(
        "the goal ended and its runs were saved",
        async () =>
          (await goalOf(receipt.chat.id))?.goal.status === "complete" &&
          (await chatDoc(receipt.chat.id))?.activeRun === null &&
          (await goalRunsOf(receipt.chat.id)).length === 2 &&
          !next.isReading(DEFAULT_TENANT_DB_NAME, chatId),
        30_000,
      );
      assert.deepEqual(reads(), [false, false]);
      assert.equal((await assertGoalSettled(receipt.chat.id, ref)).length, 2);
    } finally {
      await other.close();
    }
  });

  // The goal lifecycle API (tasks/goal-mode-todo.md, Task 10).
  interface GoalBody {
    goal: {
      objective: string;
      status: string;
      tokenBudget: number | null;
      tokensUsed: number;
      origin: string;
      review: string;
    };
  }
  const goalPath = (chatId: string, action = "") =>
    `/chats/${chatId}/goal${action}`;
  const goalStart = (objective?: string, tokenBudget = 300_000) => ({
    clientRequestId: clientId(),
    ...(objective !== undefined ? { objective } : {}),
    tokenBudget,
  });
  const userSlots = async (chatId: string) =>
    running.app
      .get(GoalStore)
      .userSlots(
        DEFAULT_TENANT_DB_NAME,
        tenantId,
        (await chatDoc(chatId))!.ownerId,
      );
  // Counts the goal sets platform-next sends the adapter.
  function countGoalSets() {
    const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
    const original = client.setGoal.bind(client);
    const counter = {
      sets: 0,
      fail: undefined as Error | undefined,
      restore: () => {
        client.setGoal = original;
      },
    };
    client.setGoal = async (ref, body) => {
      counter.sets++;
      if (counter.fail) throw counter.fail;
      return original(ref, body);
    };
    return counter;
  }
  async function untilGoalDone(chatId: string) {
    const id = ObjectId.createFromHexString(chatId);
    await until(
      "the goal completed and its runs were saved",
      async () =>
        (await goalOf(chatId))?.goal.status === "complete" &&
        (await chatDoc(chatId))?.activeRun === null &&
        !running.app.get(GoalWatcher).isReading(DEFAULT_TENANT_DB_NAME, id),
      30_000,
    );
  }

  test("a member starts a goal with an objective and a preset; a retry with the same client ID returns it; a second goal, or any goal after clear, is refused", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    const counter = countGoalSets();
    try {
      // Invalid input is refused before anything is sent.
      for (const body of [
        goalStart(GOAL_OBJECTIVE, 123_456),
        goalStart(GOAL_OBJECTIVE, 2_000_000),
        goalStart(""),
        goalStart("x".repeat(4001)),
        goalStart("bad\u202Eobjective"),
        { objective: GOAL_OBJECTIVE, tokenBudget: 300_000 },
        { ...goalStart(GOAL_OBJECTIVE), extra: 1 },
      ])
        await fails(
          await call(alice, "POST", goalPath(id), body),
          400,
          "BAD_REQUEST",
        );
      assert.equal(counter.sets, 0);
      gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
      const body = goalStart(GOAL_OBJECTIVE);
      const started = await json<GoalBody>(
        await call(alice, "POST", goalPath(id), body),
        201,
      );
      assert.equal(started.goal.objective, GOAL_OBJECTIVE);
      assert.equal(started.goal.status, "active");
      assert.equal(started.goal.tokenBudget, 300_000);
      assert.equal(started.goal.origin, "user");
      const again = await json<GoalBody>(
        await call(alice, "POST", goalPath(id), body),
        200,
      );
      assert.equal(again.goal.objective, GOAL_OBJECTIVE);
      assert.equal(counter.sets, 1, "a retry sends nothing");
      await fails(
        await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
        409,
        "CONFLICT",
      );
      await untilGoalDone(id);
      const read = await json<GoalBody>(
        await call(alice, "GET", goalPath(id)),
        200,
      );
      assert.equal(read.goal.status, "complete");
      assert.equal(read.goal.review, "pending");
      assert.equal(await userSlots(id), 0);

      assert.deepEqual(
        await json(await call(alice, "DELETE", goalPath(id)), 200),
        { cleared: true },
      );
      const runtime = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
      assert.equal(await runtime.getGoal(ref), null);
      assert.equal((await goalOf(id))?.ended, true);
      assert.equal("goal" in (await chatDoc(id))!, false);
      assert.deepEqual(
        await json(await call(alice, "GET", goalPath(id)), 200),
        { goal: null },
      );
      const sets = counter.sets;
      await fails(
        await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
        409,
        "CONFLICT",
      );
      await fails(
        await call(alice, "POST", goalPath(id), body),
        409,
        "CONFLICT",
      );
      assert.equal(counter.sets, sets, "nothing sent after clear");
    } finally {
      counter.restore();
    }
  });

  test("a start at the member's or the tenant's limit is refused with GOAL_LIMIT and sends nothing; an adapter failure leaves no slot held, and a retry starts it", async () => {
    const { receipt } = await activeGoalChat();
    const id = receipt.chat.id;
    const store = running.app.get(GoalStore);
    const ownerId = (await chatDoc(id))!.ownerId;
    const counter = countGoalSets();
    try {
      for (let i = 0; i < 3; i++)
        assert.equal(
          await store.takeSlot(DEFAULT_TENANT_DB_NAME, tenantId, ownerId, 10),
          true,
        );
      const body = goalStart(GOAL_OBJECTIVE);
      const refused = await fails(
        await call(alice, "POST", goalPath(id), body),
        409,
        "GOAL_LIMIT",
      );
      assert.equal(
        JSON.parse(refused).error.message,
        "3 goals running. Pause or finish one.",
      );
      for (let i = 0; i < 3; i++)
        await store.giveSlot(DEFAULT_TENANT_DB_NAME, tenantId, ownerId);

      // The tenant's cap: one goal, held by another member.
      await operator.setTenantGoals({
        operator: "ops",
        tenantId,
        goals: {
          presets: [100_000, 300_000, 500_000],
          maxTokenBudget: 1_000_000,
          maxActive: 1,
        },
      });
      const other = new ObjectId();
      assert.equal(
        await store.takeSlot(DEFAULT_TENANT_DB_NAME, tenantId, other, 1),
        true,
      );
      await fails(
        await call(alice, "POST", goalPath(id), body),
        409,
        "GOAL_LIMIT",
      );
      await store.giveSlot(DEFAULT_TENANT_DB_NAME, tenantId, other);
      assert.equal(counter.sets, 0);
      assert.equal(await userSlots(id), 0);

      for (const fail of [
        new AdapterRefusal(503, "RUNTIME_UNAVAILABLE", true),
        new AdapterUnreachable("timeout"),
      ]) {
        counter.fail = fail;
        await fails(
          await call(alice, "POST", goalPath(id), body),
          503,
          "UNAVAILABLE",
        );
        assert.equal(await userSlots(id), 0, fail.name);
        assert.equal("goalStart" in (await chatDoc(id))!, false, fail.name);
        assert.equal(await goalOf(id), null, fail.name);
      }
      counter.fail = undefined;
      gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
      const started = await json<GoalBody>(
        await call(alice, "POST", goalPath(id), body),
        201,
      );
      assert.equal(started.goal.status, "active");
      await untilGoalDone(id);
      assert.equal(await userSlots(id), 0);
    } finally {
      counter.restore();
    }
  });

  test("another member, another tenant, an unknown or an archived chat get the same not-found on every goal route", async () => {
    const { receipt } = await activeGoalChat();
    const id = receipt.chat.id;
    // The owner reaches the routes.
    assert.deepEqual(await json(await call(alice, "GET", goalPath(id)), 200), {
      goal: null,
    });
    const counter = countGoalSets();
    const routes = (chatId: string): Array<[string, string, unknown?]> => [
      ["GET", goalPath(chatId)],
      ["POST", goalPath(chatId), goalStart(GOAL_OBJECTIVE)],
      ["PATCH", goalPath(chatId), { objective: GOAL_OBJECTIVE }],
      ["POST", goalPath(chatId, "/pause")],
      ["POST", goalPath(chatId, "/resume")],
      ["DELETE", goalPath(chatId)],
    ];
    try {
      const unknown = new ObjectId().toHexString();
      for (const [who, chatId] of [
        [bob, id],
        [dave, id],
        [alice, unknown],
      ] as const)
        for (const [method, path, body] of routes(chatId))
          await fails(await call(who, method, path, body), 404, "NOT_FOUND");
      await json(await call(alice, "POST", `/chats/${id}/archive`), 200);
      for (const [method, path, body] of routes(id))
        await fails(await call(alice, method, path, body), 404, "NOT_FOUND");
      assert.equal(counter.sets, 0);
    } finally {
      counter.restore();
    }
  });

  test("pause gives the slot back and stops the goal; the objective can be edited; resume is refused during a turn, then claims a slot and continues", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(
      { kind: "held", before: "STEP", after: "_ONE" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await gateway.waitForRequests(2);
    assert.equal(await userSlots(id), 1);
    const paused = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/pause")),
      200,
    );
    assert.equal(paused.goal.status, "paused");
    assert.equal(await userSlots(id), 0);
    assert.equal((await goalOf(id))?.slotHeld, false);
    const edited = await json<GoalBody>(
      await call(alice, "PATCH", goalPath(id), {
        objective: "EDITED_OBJECTIVE: the annual summary.",
      }),
      200,
    );
    assert.equal(
      edited.goal.objective,
      "EDITED_OBJECTIVE: the annual summary.",
    );
    assert.equal(edited.goal.status, "paused");
    // The goal turn is still running: nothing can make the goal active.
    await fails(
      await call(alice, "POST", goalPath(id, "/resume")),
      409,
      "CHAT_BUSY",
    );
    assert.equal(await userSlots(id), 0);
    gateway.release();
    await until(
      "the paused goal's turn was saved",
      async () =>
        (await chatDoc(id))?.activeRun === null &&
        (await goalRunsOf(id)).length === 1,
    );
    const runtime = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
    assert.equal((await runtime.getGoal(ref))?.status, "paused");
    const resumed = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/resume")),
      200,
    );
    assert.equal(resumed.goal.status, "active");
    await untilGoalDone(id);
    assert.equal(await userSlots(id), 0);
    assert.deepEqual(
      (await goalRunsOf(id)).map((run) => run.status),
      ["completed", "completed"],
    );
  });

  // Task 18: the whole flow through the member's routes, with no browser
  // reading the chat.
  test("a goal started by route runs three turns with no browser, completes, takes requested changes, completes again and is approved; every turn is saved once", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(
      { kind: "reply", text: "STEP_ONE" },
      { kind: "reply", text: "STEP_TWO" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await untilGoalDone(id);
    assert.equal((await assertGoalSettled(id, ref)).length, 3);

    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "FIXED_DONE" });
    const reopened = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/request-changes"), {
        feedback: "Add a chart per region.",
      }),
      200,
    );
    assert.equal(reopened.goal.status, "active");
    assert.equal(
      reopened.goal.objective,
      `${GOAL_OBJECTIVE}\n\nChanges requested: Add a chart per region.`,
    );
    await untilGoalDone(id);
    assert.equal((await assertGoalSettled(id, ref)).length, 4);

    const approved = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/approve")),
      200,
    );
    assert.equal(approved.goal.review, "approved");
    assert.deepEqual(await goalTexts(id), [
      "STEP_ONE",
      "STEP_TWO",
      "GOAL_DONE",
      "FIXED_DONE",
    ]);
    assert.equal(await userSlots(id), 0);
  });

  test("two starts racing for the last slot: one goal starts, the other gets GOAL_LIMIT and holds nothing", async () => {
    const settings = {
      presets: [100_000, 300_000, 500_000] as [number, number, number],
      maxTokenBudget: 1_000_000,
      maxActive: 1,
    };
    const first = (await activeGoalChat(settings)).receipt.chat.id;
    const second = (await activeGoalChat(settings)).receipt.chat.id;
    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
    const answers = await Promise.all(
      [first, second].map((id) =>
        call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      ),
    );
    assert.deepEqual(answers.map((res) => res.status).sort(), [201, 409]);
    const lost = answers.findIndex((res) => res.status === 409);
    const body = (await answers[lost]!.json()) as { error: { code: string } };
    assert.equal(body.error.code, "GOAL_LIMIT");
    await answers[1 - lost]!.text();
    const winner = [first, second][1 - lost]!;
    const loser = [first, second][lost]!;
    assert.deepEqual(
      await json(await call(alice, "GET", goalPath(loser)), 200),
      { goal: null },
    );
    assert.equal((await chatDoc(loser))?.goalStart, undefined);
    await untilGoalDone(winner);
    assert.equal(await userSlots(winner), 0);
  });

  test("a stalled goal resumes like a paused one, claiming a slot", async () => {
    const { receipt } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(
      { kind: "call", name: "update_goal", args: { status: "blocked" } },
      { kind: "reply", text: "STUCK" },
    );
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await until(
      "the goal stalled and its turn was saved",
      async () =>
        (await goalOf(id))?.goal.status === "blocked" &&
        (await chatDoc(id))?.activeRun === null,
      30_000,
    );
    assert.equal(await userSlots(id), 0);
    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
    const resumed = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/resume")),
      200,
    );
    assert.equal(resumed.goal.status, "active");
    await untilGoalDone(id);
    assert.equal(await userSlots(id), 0);
  });

  test("a goal the model proposes is started by choosing a preset; after clear, a later model goal is cleared, not shown", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    const createGoal = {
      kind: "call",
      name: "create_goal",
      args: { objective: "MODEL_GOAL: tidy the notes." },
    } as const;
    gateway.script.push(createGoal, { kind: "reply", text: "MEMBER_DONE" });
    await finish(
      alice,
      await json<Receipt>(await followUp(alice, id, "Tidy up."), 202),
    );
    await until("the proposal was recorded", async () => {
      const goal = await goalOf(id);
      return goal?.origin === "model" && goal.goal.status === "paused";
    });
    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
    const started = await json<GoalBody>(
      await call(alice, "POST", goalPath(id), goalStart(undefined, 100_000)),
      201,
    );
    assert.equal(started.goal.objective, "MODEL_GOAL: tidy the notes.");
    assert.equal(started.goal.origin, "user");
    assert.equal(started.goal.tokenBudget, 100_000);
    assert.equal(started.goal.status, "active");
    await untilGoalDone(id);
    await json(await call(alice, "DELETE", goalPath(id)), 200);

    gateway.script.push(createGoal, { kind: "reply", text: "AFTER_CLEAR" });
    await finish(
      alice,
      await json<Receipt>(await followUp(alice, id, "Tidy again."), 202),
    );
    const runtime = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
    await until(
      "the later model goal was cleared",
      async () => (await runtime.getGoal(ref)) === null,
    );
    const saved = (await goalOf(id))!;
    assert.equal(saved.ended, true);
    assert.equal(saved.goal.objective, "MODEL_GOAL: tidy the notes.");
    assert.equal("goal" in (await chatDoc(id))!, false);
    assert.deepEqual(await json(await call(alice, "GET", goalPath(id)), 200), {
      goal: null,
    });
  });

  // Review and budget (tasks/goal-mode-todo.md, Task 11).
  const goalAudits = (chatId: string) =>
    database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({ action: /^goal\./, "details.chatId": chatId })
      .sort({ at: 1 })
      .toArray();
  const decisionKinds = async (chatId: string) =>
    (await goalOf(chatId))!.history
      .map((entry) => entry.kind)
      .filter((kind) =>
        ["approved", "accepted_as_is", "changes_requested"].includes(kind),
      );
  async function untilGoalStatus(chatId: string, status: string) {
    const id = ObjectId.createFromHexString(chatId);
    await until(
      `the goal became ${status} and its runs were saved`,
      async () =>
        (await goalOf(chatId))?.goal.status === status &&
        (await chatDoc(chatId))?.activeRun === null &&
        !running.app.get(GoalWatcher).isReading(DEFAULT_TENANT_DB_NAME, id),
      60_000,
    );
  }

  test("request changes on a completed goal sends one set with the merged objective, keeps the goal's createdAt and tokensUsed and claims a slot; a merge over 4000 characters is refused", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await untilGoalDone(id);
    const runtime = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
    const done = (await runtime.getGoal(ref))!;
    const counter = countGoalSets();
    try {
      // Refused before anything is sent: a merge that would not fit, empty
      // feedback, and a budget not above what the goal has used.
      const tooLong = await fails(
        await call(alice, "POST", goalPath(id, "/request-changes"), {
          feedback: "x".repeat(4000 - GOAL_OBJECTIVE.length),
        }),
        400,
        "OBJECTIVE_TOO_LONG",
      );
      assert.equal(JSON.parse(tooLong).error.details.maxCharacters, 4000);
      for (const body of [
        { feedback: "" },
        { feedback: "FEEDBACK", tokenBudget: done.tokensUsed },
        { feedback: "FEEDBACK", tokenBudget: 1_000_001 },
        { feedback: "FEEDBACK", extra: 1 },
      ])
        await fails(
          await call(alice, "POST", goalPath(id, "/request-changes"), body),
          400,
          "BAD_REQUEST",
        );
      assert.equal(counter.sets, 0);
      assert.equal((await goalOf(id))?.review, "pending");
      assert.equal(await userSlots(id), 0);

      gateway.script.push(
        { kind: "held", before: "MORE", after: "_WORK" },
        COMPLETE_GOAL,
        { kind: "reply", text: "GOAL_DONE_AGAIN" },
      );
      const requests = gateway.requests.length;
      const changed = await json<GoalBody>(
        await call(alice, "POST", goalPath(id, "/request-changes"), {
          feedback: "FEEDBACK: add a chart per region.",
          tokenBudget: 500_000,
        }),
        200,
      );
      const merged = `${GOAL_OBJECTIVE}\n\nChanges requested: FEEDBACK: add a chart per region.`;
      assert.equal(counter.sets, 1, "one set");
      assert.equal(changed.goal.objective, merged);
      assert.equal(changed.goal.status, "active");
      assert.equal(changed.goal.tokenBudget, 500_000);
      assert.equal(changed.goal.tokensUsed, done.tokensUsed);
      assert.equal(changed.goal.review, "none");
      const reopened = (await runtime.getGoal(ref))!;
      assert.equal(reopened.createdAt, done.createdAt, "the same goal");
      assert.equal(reopened.objective, merged);
      await gateway.waitForRequests(requests + 1);
      assert.equal(await userSlots(id), 1, "a slot is held");
      // It is no longer awaiting review: a second request is refused.
      await fails(
        await call(alice, "POST", goalPath(id, "/request-changes"), {
          feedback: "FEEDBACK again",
        }),
        409,
        "CONFLICT",
      );
      assert.equal(counter.sets, 1);
      gateway.release();
      await untilGoalDone(id);
      assert.equal((await goalOf(id))?.review, "pending");
      assert.equal(await userSlots(id), 0);
      assert.deepEqual(await decisionKinds(id), ["changes_requested"]);
      const audits = await goalAudits(id);
      assert.deepEqual(
        audits.map((a) => [a.action, a.result, a.details?.tokenBudget]),
        [["goal.request_changes", "success", 500_000]],
      );
      assert.equal(JSON.stringify(audits).includes("FEEDBACK"), false);
    } finally {
      counter.restore();
    }
  });

  test("raise budget accepts only values above tokensUsed and at most the chat maximum; accept as is works only for a budget-limited goal at the maximum", async () => {
    const { receipt } = await activeGoalChat({
      presets: [60, 90, 120],
      maxTokenBudget: 300,
      maxActive: 10,
    });
    const id = receipt.chat.id;
    gateway.script.push({ kind: "held", before: "STEP", after: "_ONE" });
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE, 60)),
      201,
    );
    await gateway.waitForRequests(2);
    await json(await call(alice, "POST", goalPath(id, "/pause")), 200);
    // A paused goal's budget can be raised; it stays paused, with no slot.
    const counter = countGoalSets();
    try {
      const raisedPaused = await json<GoalBody>(
        await call(alice, "POST", goalPath(id, "/budget"), { tokenBudget: 90 }),
        200,
      );
      assert.equal(raisedPaused.goal.status, "paused");
      assert.equal(raisedPaused.goal.tokenBudget, 90);
      assert.equal(await userSlots(id), 0);
      assert.equal(counter.sets, 1);
      gateway.release();
      await until(
        "the paused goal's turn was saved",
        async () => (await chatDoc(id))?.activeRun === null,
      );
      await json(await call(alice, "POST", goalPath(id, "/resume")), 200);
      await untilGoalStatus(id, "budgetLimited");
      const limited = (await goalOf(id))!.goal;
      assert.equal(limited.tokenBudget, 90);
      assert.ok(limited.tokensUsed >= 90, String(limited.tokensUsed));

      const sets = counter.sets;
      // Below the maximum: accept as is is refused, and so is approve.
      await fails(
        await call(alice, "POST", goalPath(id, "/accept")),
        409,
        "CONFLICT",
      );
      await fails(
        await call(alice, "POST", goalPath(id, "/approve")),
        409,
        "CONFLICT",
      );
      for (const tokenBudget of [limited.tokensUsed, 301, 150.5, 0])
        await fails(
          await call(alice, "POST", goalPath(id, "/budget"), { tokenBudget }),
          400,
          "BAD_REQUEST",
        );
      assert.equal(counter.sets, sets, "nothing sent");

      // Raised to the maximum: the goal is active again with a slot, then
      // stops at the maximum.
      const raised = await json<GoalBody>(
        await call(alice, "POST", goalPath(id, "/budget"), {
          tokenBudget: 300,
        }),
        200,
      );
      assert.equal(raised.goal.status, "active");
      assert.equal(raised.goal.tokenBudget, 300);
      assert.equal(counter.sets, sets + 1);
      await untilGoalStatus(id, "budgetLimited");
      assert.equal(await userSlots(id), 0);
      assert.equal((await goalOf(id))!.goal.tokenBudget, 300);

      const accepted = await json<GoalBody>(
        await call(alice, "POST", goalPath(id, "/accept")),
        200,
      );
      assert.equal(accepted.goal.review, "accepted_as_is");
      assert.equal(accepted.goal.status, "budgetLimited");
      assert.equal(counter.sets, sets + 1, "accept sends nothing");
      assert.deepEqual((await chatDoc(id))?.goal?.review, "accepted_as_is");
      assert.deepEqual(await decisionKinds(id), ["accepted_as_is"]);
      // Each raised budget is in the goal history, as Codex reported it.
      assert.deepEqual(
        (await goalOf(id))!.history
          .filter((entry) => entry.kind === "budget")
          .map((entry) => entry.tokenBudget),
        [90, 300],
      );
      assert.deepEqual(
        (await goalAudits(id)).map((a) => [a.action, a.details?.tokenBudget]),
        [
          ["goal.raise_budget", 90],
          ["goal.raise_budget", 300],
          ["goal.accept_as_is", 300],
        ],
      );
    } finally {
      counter.restore();
    }
  });

  test("approve works only for a goal awaiting review; a repeat changes nothing; every decision is audited and in the goal history", async () => {
    const { receipt } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(
      { kind: "held", before: "STEP", after: "_ONE" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await gateway.waitForRequests(2);
    // While it runs there is nothing to review or accept, and its budget
    // cannot change until the turn ends.
    for (const action of ["/approve", "/accept"])
      await fails(
        await call(alice, "POST", goalPath(id, action)),
        409,
        "CONFLICT",
      );
    await fails(
      await call(alice, "POST", goalPath(id, "/budget"), {
        tokenBudget: 500_000,
      }),
      409,
      "CHAT_BUSY",
    );
    gateway.release();
    await untilGoalDone(id);
    // A completed goal is not budget-limited, and its budget is not raised.
    await fails(
      await call(alice, "POST", goalPath(id, "/accept")),
      409,
      "CONFLICT",
    );
    await fails(
      await call(alice, "POST", goalPath(id, "/budget"), {
        tokenBudget: 500_000,
      }),
      409,
      "CONFLICT",
    );
    // Another member's or tenant's chat is the same not-found.
    for (const who of [bob, dave])
      for (const [action, body] of [
        ["/approve"],
        ["/accept"],
        ["/budget", { tokenBudget: 500_000 }],
        ["/request-changes", { feedback: "FEEDBACK" }],
      ] as const)
        await fails(
          await call(who, "POST", goalPath(id, action), body),
          404,
          "NOT_FOUND",
        );
    assert.deepEqual(await goalAudits(id), []);

    // A complete goal not waiting for review (as while a request for changes
    // reopens it) is not approved either.
    const goalId = { chatId: ObjectId.createFromHexString(id) };
    await goalsCollection().updateOne(goalId, { $set: { review: "none" } });
    await fails(
      await call(alice, "POST", goalPath(id, "/approve")),
      409,
      "CONFLICT",
    );
    await goalsCollection().updateOne(goalId, { $set: { review: "pending" } });

    const approved = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/approve")),
      200,
    );
    assert.equal(approved.goal.review, "approved");
    assert.equal(approved.goal.status, "complete");
    assert.equal((await chatDoc(id))?.goal?.review, "approved");
    const again = await json<GoalBody>(
      await call(alice, "POST", goalPath(id, "/approve")),
      200,
    );
    assert.equal(again.goal.review, "approved");
    await fails(
      await call(alice, "POST", goalPath(id, "/request-changes"), {
        feedback: "FEEDBACK",
      }),
      409,
      "CONFLICT",
    );
    assert.deepEqual(await decisionKinds(id), ["approved"]);
    assert.deepEqual(
      (await goalAudits(id)).map((a) => [a.action, a.result]),
      [["goal.approve", "success"]],
    );
  });

  // The browser chat stream, badges and archive (Task 12).
  // Reads a chat event stream into `events` until aborted.
  function chatEvents(who: Member, chatId: string) {
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const opened = call(
      who,
      "GET",
      `/chats/${chatId}/events`,
      undefined,
      controller.signal,
    );
    const reading = opened
      .then((res) =>
        res.status === 200
          ? readStream(res, (event) => {
              events.push(event);
            })
          : undefined,
      )
      .catch(() => undefined);
    return {
      events,
      opened,
      async close() {
        controller.abort();
        await reading;
      },
    };
  }
  const dbCalls = (res: Response) =>
    timingOf(res).find(([name]) => name === "db")?.[1] ?? 0;

  test("the chat event stream starts with a snapshot, relays a goal turn's run.started and the goal's updates, and the run can be attached; a reconnect starts with a snapshot", async () => {
    const { receipt } = await activeGoalChat();
    const id = receipt.chat.id;
    for (const who of [bob, dave])
      await fails(
        await call(who, "GET", `/chats/${id}/events`),
        404,
        "NOT_FOUND",
      );
    gateway.script.push(
      { kind: "held", before: "STEP", after: "_ONE" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    const live = chatEvents(alice, id);
    try {
      await until("the snapshot arrived", () => live.events.length > 0);
      assert.equal(live.events[0]?.type, "snapshot");
      assert.deepEqual(live.events[0]?.data, { goal: null, activeRunId: null });
      await json(
        await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
        201,
      );
      await until("a goal turn was announced", () =>
        live.events.some((e) => e.type === "run.started"),
      );
      const started = live.events.find((e) => e.type === "run.started")!;
      const runId = String(started.data.runId);
      assert.match(runId, /^[0-9a-f]{24}$/);
      assert.equal(typeof started.data.turnId, "string");
      // A reconnect mid-turn starts with a snapshot naming that run.
      const mid = chatEvents(alice, id);
      try {
        await until(
          "the reconnect's snapshot arrived",
          () => mid.events.length > 0,
        );
        assert.equal(mid.events[0]?.type, "snapshot");
        assert.equal(mid.events[0]?.data.activeRunId, runId);
      } finally {
        await mid.close();
      }
      // The announced run is attached through its own stream, mid-turn.
      const attached = readStream(await stream(alice, id, runId));
      gateway.release();
      assert.deepEqual(
        savedOf(await attached).messages.map((m) => m.text),
        ["STEP_ONE"],
      );
      await untilGoalDone(id);
      await until("the completion was relayed", () =>
        live.events.some(
          (e) =>
            e.type === "goal.updated" &&
            (e.data.goal as { status?: string })?.status === "complete",
        ),
      );
      const updates = live.events.filter((e) => e.type === "goal.updated");
      assert.equal(
        (updates[0]?.data.goal as { objective?: string })?.objective,
        GOAL_OBJECTIVE,
      );
      assert.equal(
        live.events.filter((e) => e.type === "run.started").length,
        (await goalRunsOf(id)).length,
        "each goal turn announced once",
      );
    } finally {
      await live.close();
    }
    const again = chatEvents(alice, id);
    try {
      await until("the snapshot arrived", () => again.events.length > 0);
      assert.equal(again.events[0]?.type, "snapshot");
      assert.deepEqual(
        (again.events[0]?.data.goal as { status?: string; review?: string })
          ?.status,
        "complete",
      );
      assert.equal(
        (again.events[0]?.data.goal as { review?: string })?.review,
        "pending",
      );
      assert.equal(again.events[0]?.data.activeRunId, null);
    } finally {
      await again.close();
    }
  });

  test("the chat list returns each chat's goal status and review without an extra query per chat", async () => {
    const plain = await json<Receipt>(await startChat(alice), 202);
    await finish(alice, plain);
    const before = await call(alice, "GET", "/chats");
    const listed = await json<{ chats: Array<{ id: string; goal: unknown }> }>(
      before,
      200,
    );
    assert.deepEqual(
      listed.chats.map((c) => c.goal),
      [null],
    );
    const { receipt } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(COMPLETE_GOAL, { kind: "reply", text: "GOAL_DONE" });
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await untilGoalDone(id);
    const after = await call(alice, "GET", "/chats");
    const both = await json<{
      chats: Array<{ id: string; goal: unknown }>;
    }>(after, 200);
    assert.deepEqual(
      Object.fromEntries(both.chats.map((c) => [c.id, c.goal])),
      {
        [plain.chat.id]: null,
        [id]: { status: "complete", review: "pending" },
      },
    );
    assert.equal(dbCalls(after), dbCalls(before), "no query per chat");
    const one = await json<{ chat: { goal: unknown } }>(
      await call(alice, "GET", `/chats/${id}`),
      200,
    );
    assert.deepEqual(one.chat.goal, { status: "complete", review: "pending" });
  });

  test("archiving a chat clears its goal in the runtime and frees its slot before the chat is hidden; a clear that fails keeps the chat", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    // A goal Codex holds, paused: archive clears it there.
    gateway.script.push({ kind: "held", before: "STEP", after: "_ONE" });
    await json(
      await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
      201,
    );
    await gateway.waitForRequests(2);
    await json(await call(alice, "POST", goalPath(id, "/pause")), 200);
    gateway.release();
    await until(
      "the turn ended",
      async () => (await chatDoc(id))?.activeRun === null,
      30_000,
    );
    const runtime = new RuntimeClient(adapter.url, ADAPTER_TOKEN);
    assert.equal((await runtime.getGoal(ref))?.status, "paused");
    // Counted as active, as a goal between turns is.
    const chatId = ObjectId.createFromHexString(id);
    await goalsCollection().updateOne(
      { chatId },
      { $set: { "goal.status": "active" } },
    );
    assert.equal(
      await running.app
        .get(GoalStore)
        .claimSlot(DEFAULT_TENANT_DB_NAME, tenantId, chatId, 10),
      true,
    );
    assert.equal(await userSlots(id), 1);

    // The runtime cannot be reached: nothing is hidden, nothing given back.
    const client = running.app.get<RuntimeClient>(RUNTIME_CLIENT);
    const original = client.clearGoal.bind(client);
    client.clearGoal = () =>
      Promise.reject(new AdapterUnreachable("test: adapter down"));
    try {
      await fails(
        await call(alice, "POST", `/chats/${id}/archive`),
        503,
        "UNAVAILABLE",
      );
    } finally {
      client.clearGoal = original;
    }
    assert.equal((await chatDoc(id))?.status, "active");
    assert.equal(await userSlots(id), 1);

    const archived = await json<{ chat: { status: string; goal: unknown } }>(
      await call(alice, "POST", `/chats/${id}/archive`),
      200,
    );
    assert.equal(archived.chat.status, "archived");
    assert.equal(archived.chat.goal, null);
    assert.equal(await runtime.getGoal(ref), null, "cleared in the runtime");
    assert.equal(await userSlots(id), 0);
    assert.equal((await goalOf(id))?.ended, true);
    assert.equal((await goalOf(id))?.slotHeld, false);
    assert.equal("goal" in ((await chatDoc(id)) ?? {}), false);
    await fails(await call(alice, "GET", goalPath(id)), 404, "NOT_FOUND");
  });

  // Checkpoint B (tasks/goal-mode-todo.md): the member starts a goal through
  // the API with the chat open, then closes it mid-turn; the GoalWatcher
  // saves every turn with nobody connected.
  test("a goal started through the API is saved turn by turn after the browser disconnects, every turn once", async () => {
    const { receipt, ref } = await activeGoalChat();
    const id = receipt.chat.id;
    gateway.script.push(
      { kind: "held", before: "STEP", after: "_ONE" },
      { kind: "reply", text: "STEP_TWO" },
      COMPLETE_GOAL,
      { kind: "reply", text: "GOAL_DONE" },
    );
    const live = chatEvents(alice, id);
    try {
      await until("the browser is connected", () => live.events.length > 0);
      assert.equal(live.events[0]?.type, "snapshot");
      await json(
        await call(alice, "POST", goalPath(id), goalStart(GOAL_OBJECTIVE)),
        201,
      );
      // The first goal turn is under way when the browser goes away.
      await gateway.waitForRequests(2);
    } finally {
      await live.close();
    }
    gateway.release();
    await untilGoalDone(id);
    assert.equal((await assertGoalSettled(id, ref)).length, 3);
    assert.deepEqual(await goalTexts(id), [
      "STEP_ONE",
      "STEP_TWO",
      "GOAL_DONE",
    ]);
  });

  test("shutdown lets a reply in flight finish and turns new messages away", async () => {
    gateway.script.push({ kind: "held", before: "Draining", after: " done." });
    const receipt = await json<Receipt>(await startChat(alice), 202);
    await until("the model was called", () => gateway.requests.length === 1);
    const drained = running.app.get(RunExecutor).drain(10_000);
    await fails(await startChat(alice), 503, "UNAVAILABLE");
    gateway.release();
    await drained;
    const body = await getChat(alice, receipt.chat.id);
    assert.equal(body.chat.activeRunId, null);
    assert.equal(body.messages[1]?.text, "Draining done.");
    await running.close();
    await boot();
  });
});

describe("chat without runtime configuration", () => {
  test("chat endpoints answer 503", async () => {
    const mongo = await startReplicaSet();
    const app = await startApp({ mongodbUri: mongo.getUri() });
    try {
      const operator = app.app.get(OperatorService);
      const tenantId = new ObjectId();
      await operator.provisionTenant({
        operator: "ops",
        tenantId,
        name: "Truex",
        kind: "default",
      });
      const { user } = await app.app
        .get(UsersService)
        .findOrCreateFromIdentity({
          provider: "google",
          subject: "erin",
          email: "erin@example.test",
          emailVerified: true,
          name: "erin",
        });
      await app.app
        .get(MembershipsService)
        .join({ userId: user._id, tenantId, joinedVia: "signup" });
      const { accessToken } = await app.app
        .get(SessionsService)
        .create(user._id);
      const res = await fetch(
        `${app.baseUrl}/api/v1/chats?tenantId=${tenantId.toHexString()}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agentId: new ObjectId().toHexString(),
            clientMessageId: "client-message-1",
            text: "hi",
          }),
        },
      );
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, "UNAVAILABLE");
    } finally {
      await app.close();
      await mongo.stop();
    }
  });
});
