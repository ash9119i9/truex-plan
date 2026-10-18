import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
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
  RUNS_COLLECTION,
  type ChatDoc,
  type RunDoc,
} from "../../src/modules/chats/chat";
import { RunExecutor } from "../../src/modules/chats/run-executor";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { MODELS_COLLECTION } from "../../src/modules/models/model";
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
    // The picker loads the catalog cache, as the app does before a start.
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
    for (let i = 0; i < 100 && gateway.requests.length === 0; i++)
      await sleep(50);
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
    for (let i = 0; i < 100 && gateway.requests.length < 2; i++)
      await sleep(50);
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
    for (let i = 0; i < 100 && gateway.requests.length < 2; i++)
      await sleep(50);
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
        { itemId: "a", text: "One." },
        { itemId: "blank", text: "  " },
        { itemId: "b", text: "Two." },
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
