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
  RUNS_COLLECTION,
  type ChatDoc,
  type RunDoc,
} from "../../src/modules/chats/chat";
import { RecoverySweep } from "../../src/modules/chats/recovery-sweep";
import { RunExecutor } from "../../src/modules/chats/run-executor";
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
