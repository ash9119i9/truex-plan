import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import {
  MAX_FILES_PER_RUN,
  MemoryFileStore,
  type ChatFileView,
} from "../../src/modules/chats/chat-files";
import {
  CHATS_COLLECTION,
  TOOL_APPROVALS_COLLECTION,
  type ChatDoc,
  type ToolApprovalDoc,
} from "../../src/modules/chats/chat";
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

const execFileP = promisify(execFile);

// The coding path end to end: platform-next → runtime adapter (coding on) →
// the pinned Codex running real commands and edits in the chat's sandbox,
// behind a gateway stand-in that scripts the model's tool calls. Covers work
// inside the chat running without a card, the prompt-rule approval card,
// Allow for this chat surviving into the next run, the saved activity
// messages and the audit records.

describe("coding chat: platform-next → adapter (coding on) → pinned Codex", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  const gateway = new FakeGateway();
  const adapter = new AdapterProcess({ coding: true });
  const fileStore = new MemoryFileStore();
  let tenantId: ObjectId;
  let builtinId: string;
  let member: { userId: ObjectId; token: string };
  let next = 0;

  before(async () => {
    mongo = await startReplicaSet();
    await gateway.start();
    await adapter.start();
    running = await startApp({
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
        store: fileStore,
      },
    } as Partial<AppConfig> as AppConfig);
    database = running.app.get(DatabaseService);
  });

  after(async () => {
    await running?.close();
    await adapter.close();
    await gateway.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    gateway.script.length = 0;
    gateway.requests.length = 0;
    await resetOwnedData(database);
    const operator = running.app.get(OperatorService);
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
    const { user } = await running.app
      .get(UsersService)
      .findOrCreateFromIdentity({
        provider: "google",
        subject: "coder",
        email: "coder@example.test",
        emailVerified: true,
        name: "Coder",
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
    member = { userId: user._id, token: issued.accessToken };
  });

  function call(method: string, path: string, body?: unknown) {
    return fetch(
      `${running.baseUrl}/api/v1${path}${path.includes("?") ? "&" : "?"}tenantId=${tenantId.toHexString()}`,
      {
        method,
        headers: {
          authorization: `Bearer ${member.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }

  // Sends a message and reads its stream, answering each approval card with
  // `answer` as a browser would.
  async function send(
    chatId: string | null,
    text: string,
    answer: (card: Record<string, unknown>) => string,
  ): Promise<{ chatId: string; events: StreamEvent[] }> {
    const clientMessageId = `cm-${++next}-${Date.now()}`;
    const res = chatId
      ? await call("POST", `/chats/${chatId}/messages`, {
          clientMessageId,
          text,
        })
      : await call("POST", "/chats", {
          agentId: builtinId,
          clientMessageId,
          text,
        });
    const raw = await res.text();
    assert.ok(res.status === 201 || res.status === 202, raw);
    const receipt = JSON.parse(raw) as {
      chat: { id: string };
      run: { id: string };
    };
    const id = receipt.chat.id;
    const stream = await call(
      "GET",
      `/chats/${id}/runs/${receipt.run.id}/stream`,
    );
    const events = await readStream(stream, async (event) => {
      if (event.type !== "approval" || event.data.status !== "pending") return;
      const decided = await call(
        "POST",
        `/chats/${id}/runs/${receipt.run.id}/approvals/${String(event.data.approvalId)}`,
        { decision: answer(event.data) },
      );
      assert.equal(decided.status, 200, await decided.text());
    });
    return { chatId: id, events };
  }

  const workspaceFile = async (chatId: string, file: string) =>
    readFile(
      join(
        adapter.stateDir,
        "t",
        tenantId.toHexString(),
        "c",
        chatId,
        "workspace",
        file,
      ),
      "utf8",
    ).catch(() => null);

  test("a patch shows progress while it is written; only the file change is saved", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input: `*** Begin Patch\n*** Add File: notes.md\n${lines}\n*** End Patch\n`,
        stream: 20,
        delayMs: 40,
      },
      { kind: "reply", text: "Wrote notes.md." },
    );
    const { chatId, events } = await send(null, "Write notes", () => "allow");
    const progress = events.filter((e) => e.type === "progress");
    assert.ok(progress.length >= 2, `progress events: ${progress.length}`);
    for (const p of progress)
      assert.deepEqual(p.data.files, [{ path: "notes.md", kind: "add" }]);
    const types = events.map((e) => e.type);
    assert.ok(
      types.lastIndexOf("progress") < types.indexOf("activity"),
      "progress comes before the file change",
    );
    assert.equal(
      await workspaceFile(chatId, "notes.md"),
      `${lines.replace(/^\+/gm, "")}\n`,
    );
    const chat = await call("GET", `/chats/${chatId}`);
    const body = (await chat.json()) as {
      messages: Array<{ role: string; activity?: Record<string, unknown> }>;
    };
    assert.deepEqual(
      body.messages
        .filter((m) => m.role === "tool")
        .map((m) => [m.activity?.kind, m.activity?.status]),
      [["file_change", "completed"]],
    );
  });

  test("a new file streams its text, is stored as a version, and later versions only when it changes", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
    const text = `${lines.replace(/^\+/gm, "")}\n`;
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input: `*** Begin Patch\n*** Add File: docs/guide.md\n${lines}\n*** End Patch\n`,
        stream: 20,
        delayMs: 40,
      },
      { kind: "reply", text: "Done." },
    );
    const first = await send(null, "Write a guide", () => "allow");
    const { chatId } = first;

    // The viewer gets the text as it is written, in order.
    let streamed = "";
    for (const e of first.events.filter((e) => e.type === "progress")) {
      const preview = e.data.preview as
        { path: string; offset: number; text: string } | undefined;
      if (!preview) continue;
      assert.equal(preview.path, "docs/guide.md");
      assert.equal(preview.offset, streamed.length);
      streamed += preview.text;
    }
    assert.ok(streamed.length > 0 && text.startsWith(streamed));

    // The stored version is announced before the reply is saved.
    const types = first.events.map((e) => e.type);
    assert.ok(types.indexOf("files") > types.indexOf("completed"));
    assert.ok(types.indexOf("files") < types.indexOf("saved"));
    const announced = first.events.find((e) => e.type === "files")!.data
      .files as ChatFileView[];
    assert.equal(announced.length, 1);
    assert.equal(announced[0]!.path, "docs/guide.md");
    assert.equal(announced[0]!.name, "guide.md");
    assert.equal(announced[0]!.version, 1);
    assert.equal(announced[0]!.contentType, "text/markdown; charset=utf-8");

    const listed = (await (
      await call("GET", `/chats/${chatId}/files`)
    ).json()) as {
      files: ChatFileView[];
    };
    assert.deepEqual(listed.files, announced);
    const content = await call(
      "GET",
      `/chats/${chatId}/files/${announced[0]!.id}/content`,
    );
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      content.headers.get("content-disposition") ?? "",
      /^attachment; filename="guide.md"/,
    );
    assert.equal(await content.text(), text);
    const key = `t/${tenantId.toHexString()}/c/${chatId}/f/${announced[0]!.id}`;
    assert.ok(fileStore.objects.has(key), "stored under the tenant and chat");

    // A run that leaves the file alone stores nothing new.
    gateway.script.push({ kind: "reply", text: "Hi." });
    const quiet = await send(chatId, "Hello", () => "allow");
    assert.ok(!quiet.events.some((e) => e.type === "files"));

    // A run that edits it stores version 2 and keeps version 1.
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Update File: docs/guide.md\n@@\n-line 0\n+line zero\n*** End Patch\n",
      },
      { kind: "reply", text: "Edited." },
    );
    const edit = await send(chatId, "Edit it", () => "allow");
    const v2 = edit.events.find((e) => e.type === "files")!.data
      .files as ChatFileView[];
    assert.deepEqual(
      v2.map((f) => [f.path, f.version]),
      [["docs/guide.md", 2]],
    );
    const all = (await (
      await call("GET", `/chats/${chatId}/files`)
    ).json()) as {
      files: ChatFileView[];
    };
    assert.deepEqual(
      all.files.map((f) => f.version),
      [2, 1],
    );
    const old = await call(
      "GET",
      `/chats/${chatId}/files/${announced[0]!.id}/content`,
    );
    assert.equal(await old.text(), text, "version 1 is unchanged");
  });

  test("a file that can't be stored is reported unsaved and a retry stores it", async () => {
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Add File: plan.md\n+# Plan\n*** End Patch\n",
      },
      { kind: "reply", text: "Done." },
    );
    fileStore.failPuts = Object.assign(new Error("denied"), {
      name: "AccessDenied",
    });
    try {
      const { chatId, events } = await send(null, "Plan", () => "allow");
      const announced = events.find((e) => e.type === "files")!.data;
      assert.deepEqual(announced, {
        files: [],
        unsaved: ["plan.md"],
        tooLarge: [],
      });
      const saved = events.find((e) => e.type === "saved")!.data as {
        run: { id: string; unsavedFiles?: string[] };
      };
      assert.deepEqual(saved.run.unsavedFiles, ["plan.md"]);
      const runId = saved.run.id;
      const reopened = (await (
        await call("GET", `/chats/${chatId}`)
      ).json()) as {
        runs: Array<{ id: string; unsavedFiles?: string[] }>;
      };
      assert.deepEqual(
        reopened.runs.find((r) => r.id === runId)?.unsavedFiles,
        ["plan.md"],
      );

      const retry = () =>
        call("POST", `/chats/${chatId}/runs/${runId}/files/retry`);
      // Storage still refuses: still unsaved.
      const again = await retry();
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), {
        files: [],
        unsaved: ["plan.md"],
        tooLarge: [],
      });

      fileStore.failPuts = null;
      const fixed = (await (await retry()).json()) as {
        files: ChatFileView[];
        unsaved: string[];
      };
      assert.deepEqual(fixed.unsaved, []);
      assert.deepEqual(
        fixed.files.map((f) => [f.path, f.runId, f.version]),
        [["plan.md", runId, 1]],
      );
      const after = (await (await call("GET", `/chats/${chatId}`)).json()) as {
        runs: Array<{ id: string; unsavedFiles?: string[] }>;
      };
      assert.equal(
        after.runs.find((r) => r.id === runId)?.unsavedFiles,
        undefined,
      );
      // Nothing left to retry: a repeat stores nothing.
      assert.deepEqual(await (await retry()).json(), {
        files: [],
        unsaved: [],
        tooLarge: [],
      });
      // A reply that isn't in the chat is not found.
      const missing = await call(
        "POST",
        `/chats/${chatId}/runs/${new ObjectId().toHexString()}/files/retry`,
      );
      assert.equal(missing.status, 404);
    } finally {
      fileStore.failPuts = null;
    }
  });

  // The reported bug: a script makes the files, the reply says so, and the
  // chat showed only some of them with nothing to retry.
  test("files a command makes are stored, or unsaved and retried, never dropped", async () => {
    const extra = 2;
    const count = MAX_FILES_PER_RUN + extra;
    gateway.script.push(
      {
        kind: "call",
        name: "exec_command",
        args: {
          cmd: `mkdir -p out && for i in $(seq -w 1 ${count}); do printf 'r%s' "$i" > "out/report$i.xlsx"; done && printf 'doc' > summary.docx`,
        },
      },
      { kind: "reply", text: `Created ${count + 1} files.` },
    );
    const { chatId, events } = await send(null, "Make reports", () => "deny");
    const pad = (i: number) => String(i).padStart(String(count).length, "0");
    const expected = [
      ...Array.from(
        { length: count },
        (_, i) => `out/report${pad(i + 1)}.xlsx`,
      ),
      "summary.docx",
    ];
    for (const path of expected)
      assert.notEqual(await workspaceFile(chatId, path), null, path);

    const announced = events.find((e) => e.type === "files")!.data as {
      files: ChatFileView[];
      unsaved: string[];
    };
    assert.equal(announced.files.length, MAX_FILES_PER_RUN);
    // Every file in the workspace is shown or offered for retry.
    assert.deepEqual(
      [...announced.files.map((f) => f.path), ...announced.unsaved].sort(),
      [...expected].sort(),
    );
    assert.equal(announced.unsaved.length, extra + 1);
    const saved = events.find((e) => e.type === "saved")!.data as {
      run: { id: string; unsavedFiles?: string[] };
    };
    assert.deepEqual(saved.run.unsavedFiles, announced.unsaved);

    const listed = (await (
      await call("GET", `/chats/${chatId}/files`)
    ).json()) as { files: ChatFileView[] };
    assert.equal(listed.files.length, MAX_FILES_PER_RUN);

    const retried = (await (
      await call("POST", `/chats/${chatId}/runs/${saved.run.id}/files/retry`)
    ).json()) as { files: ChatFileView[]; unsaved: string[] };
    assert.deepEqual(retried.unsaved, []);
    assert.deepEqual(
      retried.files.map((f) => f.path).sort(),
      [...announced.unsaved].sort(),
    );
    const all = (await (
      await call("GET", `/chats/${chatId}/files`)
    ).json()) as { files: ChatFileView[] };
    assert.deepEqual(all.files.map((f) => f.path).sort(), [...expected].sort());
    const docx = all.files.find((f) => f.path === "summary.docx")!;
    const content = await call(
      "GET",
      `/chats/${chatId}/files/${docx.id}/content`,
    );
    assert.equal(await content.text(), "doc");

    // The next quiet run neither stores again nor reports them.
    gateway.script.push({ kind: "reply", text: "Hi." });
    const quiet = await send(chatId, "Hello", () => "deny");
    assert.ok(!quiet.events.some((e) => e.type === "files"));
  });

  test("a file over the per-file limit is too large: shown once, never offered for retry", async () => {
    gateway.script.push(
      {
        kind: "call",
        name: "exec_command",
        args: {
          cmd: "head -c 22020096 /dev/zero > dump.bin && printf 'ok' > report.csv",
        },
      },
      { kind: "reply", text: "Made dump.bin and report.csv." },
    );
    const { chatId, events } = await send(null, "Export", () => "deny");
    assert.notEqual(await workspaceFile(chatId, "dump.bin"), null);
    const announced = events.find((e) => e.type === "files")!.data as {
      files: ChatFileView[];
      unsaved: string[];
      tooLarge: string[];
    };
    assert.deepEqual(
      announced.files.map((f) => f.path),
      ["report.csv"],
    );
    assert.deepEqual(announced.unsaved, []);
    assert.deepEqual(announced.tooLarge, ["dump.bin"]);
    const saved = events.find((e) => e.type === "saved")!.data as {
      run: { id: string; unsavedFiles?: string[]; tooLargeFiles?: string[] };
    };
    assert.equal(saved.run.unsavedFiles, undefined, "nothing to retry");
    assert.deepEqual(saved.run.tooLargeFiles, ["dump.bin"]);
    const reopened = (await (await call("GET", `/chats/${chatId}`)).json()) as {
      runs: Array<{ id: string; tooLargeFiles?: string[] }>;
    };
    assert.deepEqual(
      reopened.runs.find((r) => r.id === saved.run.id)?.tooLargeFiles,
      ["dump.bin"],
    );
    // No unsaved files: a retry has nothing to do.
    assert.deepEqual(
      await (
        await call("POST", `/chats/${chatId}/runs/${saved.run.id}/files/retry`)
      ).json(),
      { files: [], unsaved: [], tooLarge: [] },
    );
    // A later reply that doesn't touch it doesn't show it again. Its time is
    // set a minute back, as when the member replies later; a reply within
    // RUN_START_SLACK_MS of the write may show it again (accepted).
    const minuteAgo = Date.now() / 1000 - 60;
    await utimes(
      join(
        adapter.stateDir,
        "t",
        tenantId.toHexString(),
        "c",
        chatId,
        "workspace",
        "dump.bin",
      ),
      minuteAgo,
      minuteAgo,
    );
    gateway.script.push({ kind: "reply", text: "Hi." });
    const quiet = await send(chatId, "Hello", () => "deny");
    assert.ok(!quiet.events.some((e) => e.type === "files"));
  });

  test("an edit a truncated listing misses is still stored, ahead of command files", async () => {
    gateway.script.push(
      {
        kind: "call",
        name: "exec_command",
        args: {
          cmd: 'for i in $(seq -w 1 510); do printf x > "f$i.txt"; done',
        },
      },
      {
        kind: "custom",
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Add File: zz/report.md\n+# Report\n*** End Patch\n",
      },
      { kind: "reply", text: "Done." },
    );
    const { events } = await send(null, "Build", () => "deny");
    const announced = events.find((e) => e.type === "files")!.data as {
      files: ChatFileView[];
      unsaved: string[];
    };
    assert.equal(announced.files[0]?.path, "zz/report.md");
    assert.equal(announced.files.length, MAX_FILES_PER_RUN);
    assert.ok(!announced.unsaved.includes("zz/report.md"));
    assert.equal(announced.unsaved.length, 50);
  });

  test("another member can't list or read a chat's files", async () => {
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Add File: a.txt\n+private\n*** End Patch\n",
      },
      { kind: "reply", text: "Done." },
    );
    const { chatId, events } = await send(null, "Write", () => "allow");
    const [file] = events.find((e) => e.type === "files")!.data
      .files as ChatFileView[];
    const { user } = await running.app
      .get(UsersService)
      .findOrCreateFromIdentity({
        provider: "google",
        subject: "other",
        email: "other@example.test",
        emailVerified: true,
        name: "Other",
      });
    await running.app
      .get(MembershipsService)
      .join({ userId: user._id, tenantId, joinedVia: "signup" });
    const sessions = running.app.get(SessionsService);
    const created = await sessions.create(user._id);
    const other = await sessions.refresh(
      created.refreshCredential,
      new Date(),
      tenantId,
    );
    const as = (path: string) =>
      fetch(
        `${running.baseUrl}/api/v1${path}?tenantId=${tenantId.toHexString()}`,
        { headers: { authorization: `Bearer ${other.accessToken}` } },
      );
    assert.equal((await as(`/chats/${chatId}/files`)).status, 404);
    assert.equal(
      (await as(`/chats/${chatId}/files/${file!.id}/content`)).status,
      404,
    );
  });

  test("edits and commands inside the chat run without a card and are saved", async () => {
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input:
          "*** Begin Patch\n*** Add File: hello.py\n+print(6*7)\n*** End Patch\n",
      },
      { kind: "call", name: "exec_command", args: { cmd: "python3 hello.py" } },
      { kind: "call", name: "exec_command", args: { cmd: "rm -r gone" } },
      { kind: "reply", text: "Created hello.py." },
    );
    const { chatId, events } = await send(null, "Write hello.py", () => "deny");
    assert.equal(
      events.filter((e) => e.type === "approval").length,
      0,
      "no card for work inside the chat",
    );
    assert.equal(await workspaceFile(chatId, "hello.py"), "print(6*7)\n");

    const chat = await call("GET", `/chats/${chatId}`);
    const body = (await chat.json()) as {
      messages: Array<{ role: string; activity?: Record<string, unknown> }>;
      runs: Array<{ usage: Record<string, number> | null }>;
    };
    // Four model calls; the run counts all of them, not only the reply.
    assert.deepEqual(
      body.runs[0]!.usage && {
        input: body.runs[0]!.usage.input,
        cached: body.runs[0]!.usage.cached,
        output: body.runs[0]!.usage.output,
      },
      { input: 80, cached: 5, output: 40 },
    );
    const activities = body.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.activity);
    assert.deepEqual(
      activities.map((a) => [a?.kind, a?.approval]),
      [
        ["file_change", undefined],
        ["command", undefined],
        ["command", undefined],
      ],
    );
    assert.equal(activities[1]?.output, "42\n");
  });

  test("a prompt-rule command asks; Allow for this chat is saved, audited and reused", async () => {
    // The first message makes the chat's files; a repository with one
    // untracked file is then set up outside the sandbox.
    gateway.script.push({ kind: "reply", text: "Ready." });
    const { chatId } = await send(null, "Start", () => "deny");
    const workspace = join(
      adapter.stateDir,
      "t",
      tenantId.toHexString(),
      "c",
      chatId,
      "workspace",
    );
    await execFileP("git", ["init", "-q"], { cwd: workspace });
    await writeFile(join(workspace, "untracked.txt"), "u\n");

    gateway.script.push(
      { kind: "call", name: "exec_command", args: { cmd: "git clean -fd" } },
      { kind: "reply", text: "Cleaned." },
    );
    const first = await send(chatId, "Clean up", () => "allow_for_chat");
    const cards = first.events.filter(
      (e) => e.type === "approval" && e.data.status === "pending",
    );
    assert.deepEqual(
      cards.map((c) => [c.data.kind, c.data.connector, c.data.tool]),
      [["command", "@workspace", "command"]],
    );
    assert.equal(await workspaceFile(chatId, "untracked.txt"), null);

    const db = database.tenantDb(DEFAULT_TENANT_DB_NAME);
    const audits = await db
      .collection<ToolApprovalDoc>(TOOL_APPROVALS_COLLECTION)
      .find({ chatId: new ObjectId(chatId) })
      .toArray();
    assert.deepEqual(
      audits.map((a) => [a.kind, a.decision, a.auto]),
      [["command", "allow_for_chat", false]],
    );
    const saved = await db
      .collection<ChatDoc>(CHATS_COLLECTION)
      .findOne({ _id: new ObjectId(chatId) });
    assert.equal(saved?.codingApprovals?.commands?.length, 1);
    assert.match(saved!.codingApprovals!.commands![0]!, /^[0-9a-f]{64}$/);

    // The next message: the same command runs without a card; a different
    // prompt-rule command asks and, denied, does not run.
    await writeFile(join(workspace, "untracked.txt"), "u\n");
    gateway.script.push(
      { kind: "call", name: "exec_command", args: { cmd: "git clean -fd" } },
      { kind: "call", name: "exec_command", args: { cmd: "git reset --hard" } },
      { kind: "reply", text: "Done." },
    );
    const second = await send(chatId, "Again", () => "deny");
    const asked = second.events.filter(
      (e) => e.type === "approval" && e.data.status === "pending",
    );
    assert.deepEqual(
      asked.map((c) => c.data.params),
      [
        [
          { name: "command", value: "git reset --hard" },
          { name: "cwd", value: "." },
        ],
      ],
    );
    assert.equal(await workspaceFile(chatId, "untracked.txt"), null);
  });

  test("reads run without a card and their output is saved", async () => {
    gateway.script.push(
      {
        kind: "custom",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: a.txt\n+alpha\n*** End Patch\n",
      },
      { kind: "call", name: "exec_command", args: { cmd: "cat a.txt" } },
      { kind: "reply", text: "It says alpha." },
    );
    const { chatId, events } = await send(
      null,
      "Make and read a.txt",
      () => "allow",
    );
    const cards = events.filter(
      (e) => e.type === "approval" && e.data.status === "pending",
    );
    assert.equal(cards.length, 0, "neither the edit nor the read asked");
    const chat = await call("GET", `/chats/${chatId}`);
    const body = (await chat.json()) as {
      messages: Array<{ role: string; activity?: Record<string, unknown> }>;
    };
    const command = body.messages.find(
      (m) => m.activity?.kind === "command",
    )?.activity;
    assert.equal(command?.command, "cat a.txt");
    assert.equal(command?.output, "alpha\n");
    assert.equal(command?.approval, undefined);
  });
});
