import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { ChatStore } from "../../src/modules/chats/chat-store";
import { CHATS_COLLECTION, type ChatDoc } from "../../src/modules/chats/chat";
import { RunExecutor } from "../../src/modules/chats/run-executor";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
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
    error: { code: string; message: string } | null;
    usage: Record<string, number> | null;
    timings: Record<string, string>;
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

  async function boot(): Promise<void> {
    running = await startApp({
      mongodbUri: mongo.getUri(),
      auth,
      chat: {
        adapterUrl: adapter.url,
        adapterToken: ADAPTER_TOKEN,
        gatewayUrl: gateway.url,
        gatewaySecret: GATEWAY_SECRET,
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
    await resetOwnedData(database);
    running.app.get(ChatStore).forgetIndexes();
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
    const issued = await running.app.get(SessionsService).create(user._id);
    return { userId: user._id, token: issued.accessToken, tenantId: tenant };
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
    assert.equal(gateway.refused, 0);
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

  test("a second message while a reply streams is refused", async () => {
    gateway.script.push({ kind: "held", before: "Working on", after: " it." });
    const first = await json<Receipt>(await startChat(alice), 202);
    // Wait until the model has started answering.
    for (let i = 0; i < 100 && gateway.requests.length === 0; i++)
      await sleep(50);
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(alice, "POST", `/chats/${first.chat.id}/messages`, {
          clientMessageId: clientId(),
          text: "and another thing",
        }),
      ),
    );
    for (const res of attempts) await fails(res, 409, "CHAT_BUSY");
    gateway.release();
    assert.equal(
      savedOf(await finish(alice, first)).messages[0]?.text,
      "Working on it.",
    );
    const after = await call(
      alice,
      "POST",
      `/chats/${first.chat.id}/messages`,
      {
        clientMessageId: clientId(),
        text: "now it works",
      },
    );
    await finish(alice, await json<Receipt>(after, 202));
    assert.equal(gateway.requests.length, 2);
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
    for (let i = 0; i < 100 && gateway.requests.length === 0; i++)
      await sleep(50);
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
    for (let i = 0; i < 100 && gateway.requests.length === 0; i++)
      await sleep(50);
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
