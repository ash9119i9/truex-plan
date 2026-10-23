import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import {
  MemoryFileStore,
  type ChatFileView,
} from "../../src/modules/chats/chat-files";
import {
  CHAT_UPLOADS_COLLECTION,
  CHATS_COLLECTION,
} from "../../src/modules/chats/chat";
import { MAX_CHAT_UPLOAD_BYTES } from "../../src/modules/chats/chat-uploads";
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
  type StreamEvent,
} from "../support/chat-stack";
import { resetOwnedData } from "../support/reset";
import { testAuthConfig } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

// Attached files end to end: staged through POST /uploads, claimed by the
// message that names them, copied by the platform into the chat's workspace
// before the run, and read there by the pinned Codex's sandboxed shell.

const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("fake docx body"),
]);
const CSV = Buffer.from("quarter,total\nQ3,42\n");

interface Stack {
  mongo: MongoMemoryReplSet;
  running: RunningApp;
  database: DatabaseService;
  gateway: FakeGateway;
  adapter: AdapterProcess;
  fileStore: MemoryFileStore;
}

async function startStack(coding: boolean): Promise<Stack> {
  const mongo = await startReplicaSet();
  const gateway = new FakeGateway();
  await gateway.start();
  const adapter = new AdapterProcess({ coding });
  await adapter.start();
  const fileStore = new MemoryFileStore();
  const running = await startApp({
    mongodbUri: mongo.getUri(),
    auth: testAuthConfig(),
    chat: {
      adapterUrl: adapter.url,
      adapterToken: ADAPTER_TOKEN,
      gatewayUrl: gateway.url,
      gatewaySecret: GATEWAY_SECRET,
      recoverySweepMs: 0,
    },
    files: {
      bucket: "test-bucket",
      region: "us-east-1",
      prefix: "",
      uploads: true,
      store: fileStore,
    },
  } as Partial<AppConfig> as AppConfig);
  return {
    mongo,
    running,
    database: running.app.get(DatabaseService),
    gateway,
    adapter,
    fileStore,
  };
}

async function stopStack(stack: Stack | undefined): Promise<void> {
  await stack?.running.close();
  await stack?.adapter.close();
  await stack?.gateway.close();
  await stack?.mongo.stop();
}

// A provisioned tenant (fresh unless `existing` names one) and a signed-in
// member of it, with the call helpers.
async function member(
  stack: Stack,
  subject: string,
  existing?: { tenantId: ObjectId; builtinId: string },
) {
  const { running } = stack;
  const operator = running.app.get(OperatorService);
  let tenantId: ObjectId;
  let builtinId: string;
  if (existing) ({ tenantId, builtinId } = existing);
  else {
    await resetOwnedData(stack.database);
    tenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId,
      name: "Truex",
      kind: "default",
    });
    await operator.putModel({ operator: "ops", definition: modelDefinition() });
    builtinId = (
      await operator.putBuiltinAgent({
        operator: "ops",
        definition: builtinDefinition(),
      })
    ).agent.id;
  }
  const { user } = await running.app
    .get(UsersService)
    .findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: subject,
    });
  await running.app
    .get(MembershipsService)
    .join({ userId: user._id, tenantId, joinedVia: "signup" });
  const sessions = running.app.get(SessionsService);
  const created = await sessions.create(user._id);
  const issued = await sessions.refresh(
    created.refreshCredential,
    new Date(),
    tenantId,
  );
  const token = issued.accessToken;
  let next = 0;

  const url = (path: string) =>
    `${running.baseUrl}/api/v1${path}${path.includes("?") ? "&" : "?"}tenantId=${tenantId.toHexString()}`;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(url(path), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const upload = (
    name: string,
    data: Buffer,
    type = "application/octet-stream",
  ) =>
    fetch(url(`/uploads?name=${encodeURIComponent(name)}`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": type },
      body: new Uint8Array(data),
    });
  const uploadId = async (name: string, data: Buffer) => {
    const res = await upload(name, data);
    const raw = await res.text();
    assert.equal(res.status, 201, raw);
    return (JSON.parse(raw) as { upload: { id: string } }).upload.id;
  };
  // Sends and, when accepted, reads the run's stream to the end.
  const send = async (
    chatId: string | null,
    body: { text?: string; attachments?: string[] },
  ) => {
    const clientMessageId = `cm-${++next}-${Date.now()}`;
    const res = chatId
      ? await call("POST", `/chats/${chatId}/messages`, {
          clientMessageId,
          ...body,
        })
      : await call("POST", "/chats", {
          agentId: builtinId,
          clientMessageId,
          ...body,
        });
    const raw = await res.text();
    if (res.status !== 202) return { status: res.status, raw, events: [] };
    const receipt = JSON.parse(raw) as {
      chat: { id: string };
      run: { id: string };
      message: Record<string, unknown>;
    };
    const stream = await call(
      "GET",
      `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stream`,
    );
    const events: StreamEvent[] = await readStream(stream);
    return { status: res.status, raw, receipt, events };
  };
  const workspaceFile = (chatId: string, file: string) =>
    readFile(
      join(
        stack.adapter.stateDir,
        "t",
        tenantId.toHexString(),
        "c",
        chatId,
        "workspace",
        file,
      ),
    ).catch(() => null);
  return {
    tenantId,
    builtinId,
    userId: user._id,
    call,
    upload,
    uploadId,
    send,
    workspaceFile,
  };
}

describe("chat uploads: platform-next → adapter (coding on) → pinned Codex", () => {
  let stack: Stack;
  let m: Awaited<ReturnType<typeof member>>;

  before(async () => {
    stack = await startStack(true);
  });
  after(() => stopStack(stack));
  beforeEach(async () => {
    stack.gateway.script.length = 0;
    stack.gateway.requests.length = 0;
    m = await member(stack, "uploader");
  });

  test("settings say uploads are on, with the limits", async () => {
    const res = await m.call("GET", "/uploads");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.enabled, true);
    assert.equal(body.maxFileBytes, 20 * 1024 * 1024);
    assert.equal(body.maxFiles, 10);
    assert.ok((body.extensions as string[]).includes("docx"));
  });

  test("attached files are in uploads/ before the run, the model is told where, and they are the chat's files", async () => {
    const docx = await m.uploadId("Report Q3.docx", DOCX);
    const csv = await m.uploadId("sales.csv", CSV);
    stack.gateway.script.push(
      {
        kind: "call",
        name: "exec_command",
        args: { cmd: "cat uploads/sales.csv" },
      },
      { kind: "reply", text: "Q3 total is 42." },
    );
    const first = await m.send(null, {
      text: "Summarize these",
      attachments: [docx, csv],
    });
    assert.equal(first.status, 202, first.raw);
    const chatId = first.receipt!.chat.id;

    // The member's message keeps its text and lists the files.
    const attachments = first.receipt!.message.attachments as Array<
      Record<string, unknown>
    >;
    assert.equal(first.receipt!.message.text, "Summarize these");
    assert.deepEqual(
      attachments.map((a) => [a.name, a.path, a.size]),
      [
        ["Report Q3.docx", "uploads/Report Q3.docx", DOCX.length],
        ["sales.csv", "uploads/sales.csv", CSV.length],
      ],
    );

    // Copied byte for byte, then read in the sandbox without a card.
    assert.deepEqual(
      await m.workspaceFile(chatId, "uploads/Report Q3.docx"),
      DOCX,
    );
    assert.deepEqual(await m.workspaceFile(chatId, "uploads/sales.csv"), CSV);
    assert.ok(!first.events.some((e) => e.type === "approval"));
    const firstInput = JSON.stringify(stack.gateway.requests[0]!.body.input);
    assert.match(firstInput, /Summarize these/);
    assert.match(firstInput, /uploads\/Report Q3\.docx/);
    assert.match(firstInput, /uploads\/sales\.csv/);
    const output = JSON.stringify(stack.gateway.requests[1]!.body.input);
    assert.match(output, /Q3,42/);

    // Not announced as the reply's own files, but listed as the chat's.
    assert.ok(!first.events.some((e) => e.type === "files"));
    const listed = (await (
      await m.call("GET", `/chats/${chatId}/files`)
    ).json()) as { files: ChatFileView[] };
    assert.deepEqual(
      listed.files.map((f) => [f.path, f.version, f.source]).sort(),
      [
        ["uploads/Report Q3.docx", 1, "upload"],
        ["uploads/sales.csv", 1, "upload"],
      ],
    );
    const fileId = attachments[0]!.fileId as string;
    const content = await m.call(
      "GET",
      `/chats/${chatId}/files/${fileId}/content`,
    );
    assert.equal(content.status, 200);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), DOCX);

    // The chat reloads with the attachments on the message.
    const chat = (await (await m.call("GET", `/chats/${chatId}`)).json()) as {
      messages: Array<{ role: string; attachments?: unknown[] }>;
    };
    assert.equal(chat.messages[0]!.attachments?.length, 2);

    // A sent upload can't be removed or sent again.
    assert.equal((await m.call("DELETE", `/uploads/${docx}`)).status, 404);
    const again = await m.send(chatId, { text: "Again", attachments: [docx] });
    assert.equal(again.status, 400, again.raw);

    // Attaching a file of the same name to a later message: version 2.
    const csv2 = await m.uploadId(
      "sales.csv",
      Buffer.from("quarter,total\nQ4,7\n"),
    );
    stack.gateway.script.push({ kind: "reply", text: "Got it." });
    const later = await m.send(chatId, { attachments: [csv2] });
    assert.equal(later.status, 202, later.raw);
    assert.equal(later.receipt!.message.text, "");
    assert.equal(
      (await m.workspaceFile(chatId, "uploads/sales.csv"))?.toString(),
      "quarter,total\nQ4,7\n",
    );
    const versions = (await (
      await m.call("GET", `/chats/${chatId}/files`)
    ).json()) as { files: ChatFileView[] };
    assert.deepEqual(
      versions.files
        .filter((f) => f.path === "uploads/sales.csv")
        .map((f) => f.version),
      [2, 1],
    );
    // The runs' captures found the copies unchanged: nothing re-stored.
    assert.equal(versions.files.length, 3);
  });

  test("a message with only files gets a title from their names", async () => {
    const csv = await m.uploadId("budget.csv", CSV);
    const sent = await m.send(null, { attachments: [csv] });
    assert.equal(sent.status, 202, sent.raw);
    const chat = sent.receipt!.chat as unknown as { title: string };
    assert.equal(chat.title, "budget.csv");
  });

  test("uploads are checked: type, contents, size, name, and the staged cap", async () => {
    const code = async (res: Response) =>
      ((await res.json()) as { error: { code: string } }).error.code;
    // Not on the allow list, contents that don't match, wrong body type.
    assert.equal((await m.upload("tool.exe", Buffer.from("MZ"))).status, 400);
    assert.equal(
      (await m.upload("report.pdf", Buffer.from("not a pdf"))).status,
      400,
    );
    assert.equal(
      (await m.upload("a.csv", CSV, "application/json")).status,
      400,
    );
    assert.equal((await m.upload("../a.csv", CSV)).status, 400);
    assert.equal((await m.upload("a.csv", Buffer.alloc(0))).status, 400);
    const big = await m.upload(
      "big.txt",
      Buffer.alloc(20 * 1024 * 1024 + 1, 0x61),
    );
    assert.equal(big.status, 413);
    assert.equal(await code(big), "PAYLOAD_TOO_LARGE");

    // A staged upload can be removed; then it can't be sent.
    const id = await m.uploadId("notes.md", Buffer.from("# Notes\n"));
    assert.equal((await m.call("DELETE", `/uploads/${id}`)).status, 204);
    assert.equal((await m.call("DELETE", `/uploads/${id}`)).status, 404);
    const gone = await m.send(null, { text: "Read it", attachments: [id] });
    assert.equal(gone.status, 400, gone.raw);
    assert.match(gone.raw, /no longer available/);

    // Staged and never sent: capped per member, expiring after a day.
    const uploads = stack.database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection(CHAT_UPLOADS_COLLECTION);
    const staged = await uploads.findOne({ ownerId: m.userId });
    assert.equal(staged, null);
    const now = Date.now();
    await uploads.insertMany(
      Array.from({ length: 30 }, () => ({
        ownerId: m.userId,
        state: "staged",
        expiresAt: new Date(now + 60_000),
      })),
    );
    const full = await m.upload("one-more.md", Buffer.from("x"));
    assert.equal(full.status, 409);
    assert.equal(await code(full), "LIMIT_REACHED");
  });

  test("another member's staged upload can't be sent or removed", async () => {
    const other = await member(stack, "someone-else", m);
    const theirs = await other.uploadId("theirs.md", Buffer.from("theirs"));
    const reuse = await m.send(null, { text: "Read", attachments: [theirs] });
    assert.equal(reuse.status, 400, reuse.raw);
    assert.equal((await m.call("DELETE", `/uploads/${theirs}`)).status, 404);
    // Still theirs to send.
    stack.gateway.script.push({ kind: "reply", text: "Read." });
    const sent = await other.send(null, {
      text: "Read",
      attachments: [theirs],
    });
    assert.equal(sent.status, 202, sent.raw);
  });

  test("files can't join a reply being written, and a chat holds at most 500 MB", async () => {
    const csv = await m.uploadId("a.csv", CSV);
    stack.gateway.script.push({ kind: "reply", text: "Hi." });
    const first = await m.send(null, { text: "Hi" });
    const chatId = first.receipt!.chat.id;

    // Near the cap: the next file doesn't fit.
    await stack.database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection(CHATS_COLLECTION)
      .updateOne(
        { _id: new ObjectId(chatId) },
        { $set: { uploadBytes: MAX_CHAT_UPLOAD_BYTES - 5 } },
      );
    const full = await m.send(chatId, { text: "More", attachments: [csv] });
    assert.equal(full.status, 409, full.raw);
    assert.match(full.raw, /LIMIT_REACHED/);
    // Refused with nothing saved: the upload is still staged and usable.
    await stack.database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection(CHATS_COLLECTION)
      .updateOne({ _id: new ObjectId(chatId) }, { $set: { uploadBytes: 0 } });

    // While a reply runs, a message with files is refused (a steer can't
    // carry them); the same files go with the next message.
    stack.gateway.script.push({ kind: "stall", text: "Done." });
    const clientMessageId = `cm-busy-${Date.now()}`;
    const busy = await m.call("POST", `/chats/${chatId}/messages`, {
      clientMessageId,
      text: "Start a long one",
    });
    assert.equal(busy.status, 202, await busy.clone().text());
    const steer = await m.call("POST", `/chats/${chatId}/messages`, {
      clientMessageId: `${clientMessageId}-2`,
      text: "And this file",
      attachments: [csv],
    });
    assert.equal(steer.status, 409, await steer.clone().text());
    assert.match(await steer.text(), /being written/);
    stack.gateway.release();
  });
});

describe("chat uploads with coding off in the runtime", () => {
  let stack: Stack;
  let m: Awaited<ReturnType<typeof member>>;

  before(async () => {
    stack = await startStack(false);
    m = await member(stack, "plain");
  });
  after(() => stopStack(stack));

  test("the run fails with a clear reason and the model is never called", async () => {
    const csv = await m.uploadId("a.csv", CSV);
    const sent = await m.send(null, { text: "Read it", attachments: [csv] });
    assert.equal(sent.status, 202, sent.raw);
    const completed = sent.events.find((e) => e.type === "completed")!;
    assert.equal(completed.data.status, "failed");
    assert.equal(
      (completed.data.error as { code: string }).code,
      "UPLOADS_DISABLED",
    );
    assert.equal(stack.gateway.requests.length, 0);
  });
});
