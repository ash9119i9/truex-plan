import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  Harness,
  completed,
  readSse,
  runAnswering,
  type SseEvent,
} from "../support/harness";
import type { Behavior } from "../support/model-fixture";

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileP("git", args, { cwd });

// Command approvals on the real pinned Codex with the coding profile
// (granular policy, `sandbox_approval: false`, `rules: true`): work inside the
// chat runs without a card; the profile's prompt rules ask; Codex itself
// refuses what would leave the sandbox (escalation, patches outside the chat)
// and what it flags as dangerous (`rm -f`). "Allow for this chat" is held by
// the adapter, re-allows only the same command, and never covers a push.

const exec = (cmd: string, extra: Record<string, unknown> = {}): Behavior => ({
  kind: "call",
  name: "exec_command",
  args: { cmd, ...extra },
});
const patch = (input: string): Behavior => ({
  kind: "custom",
  name: "apply_patch",
  input,
});
const reply: Behavior = { kind: "reply", text: "Done." };

function of(events: SseEvent[], type: string) {
  return events.filter((e) => e.type === type).map((e) => e.data);
}

describe("coding approvals (real Codex)", () => {
  const h = new Harness({ coding: true, limits: { stopMs: 3000 } });
  before(() => h.start());
  after(() => h.close());
  // A stopped scenario leaves its scripted reply unconsumed.
  beforeEach(() => {
    h.model.script.length = 0;
  });

  const workspace = (chatId: string) =>
    join(h.stateDir, "t", "tenant1", "c", chatId, "workspace");
  const exists = (chatId: string, file: string) =>
    readFile(join(workspace(chatId), file), "utf8").then(
      () => true,
      () => false,
    );
  const seed = async (chatId: string) => {
    await mkdir(join(workspace(chatId), "d"), { recursive: true });
    await writeFile(join(workspace(chatId), "a.txt"), "alpha\n");
    await writeFile(join(workspace(chatId), "d", "x.txt"), "x\n");
  };
  // A repository with one untracked file, made outside the sandbox.
  const repo = async (chatId: string) => {
    await seed(chatId);
    await git(workspace(chatId), "init", "-q");
    await writeFile(join(workspace(chatId), "untracked.txt"), "u\n");
  };
  // The model's refusal reason, as Codex returned it for the last call.
  const lastOutput = () => {
    const input = h.model.lastRequest().body.input as Array<
      Record<string, unknown>
    >;
    return String(
      input.filter((i) => String(i.type).endsWith("_output")).at(-1)?.output,
    );
  };

  // Writes, redirects, edits and deletes inside the chat: no card. The
  // platform keeps every file version instead.
  for (const [cmd, gone, made] of [
    ["touch made.txt", null, "made.txt"],
    ["echo hi > made.txt", null, "made.txt"],
    ["sed -i '' 's/a/b/' a.txt", null, null],
    ["find . -name a.txt -delete", "a.txt", null],
    ["rm a.txt", "a.txt", null],
    ["rm -r d", "d/x.txt", null],
    [`python3 -c "import shutil; shutil.rmtree('d')"`, "d/x.txt", null],
  ] as const)
    test(`runs \`${cmd}\` inside the chat without asking`, async () => {
      const chatId = "free";
      await seed(chatId);
      h.model.script.push(exec(cmd), reply);
      const { events } = await runAnswering(
        h,
        h.body({ chatId }),
        () => "deny",
      );
      assert.equal(of(events, "approval.requested").length, 0);
      const [done] = of(events, "command.completed");
      assert.equal(done!.status, "completed");
      assert.equal(done!.exitCode, 0);
      assert.equal(done!.approval, undefined);
      if (gone) assert.equal(await exists(chatId, gone), false);
      if (made) assert.equal(await exists(chatId, made), true);
    });

  // Codex flags a forced delete as dangerous; with sandbox approvals off it
  // refuses it outright and tells the model, which can use plain `rm`.
  for (const cmd of ["rm -f a.txt", "rm -rf d", "sudo rm a.txt"])
    test(`refuses \`${cmd}\` without a card`, async () => {
      await seed("dangerous");
      h.model.script.push(exec(cmd), reply);
      const { events } = await runAnswering(
        h,
        h.body({ chatId: "dangerous" }),
        () => "allow",
      );
      assert.equal(completed(events).status, "completed");
      assert.equal(of(events, "approval.requested").length, 0);
      assert.match(lastOutput(), /rejected|not permitted/i);
      assert.equal(await exists("dangerous", "a.txt"), true);
      assert.equal(await exists("dangerous", "d/x.txt"), true);
    });

  // The profile's prompt rules match history-destroying git commands: each
  // asks, and Deny never runs it.
  for (const cmd of ["git reset --hard", "git clean -fd"])
    test(`asks before \`${cmd}\`; Deny means it never runs`, async () => {
      await repo("deny");
      h.model.script.push(exec(cmd), reply);
      const { events } = await runAnswering(
        h,
        h.body({ chatId: "deny" }),
        () => "deny",
      );
      const [asked] = of(events, "approval.requested");
      assert.ok(asked, "an approval card was shown");
      assert.equal(asked.kind, "command");
      assert.equal(asked.tool, "command");
      // Shown as it runs, without Codex's shell wrapper.
      const [shown, cwd] = asked.params as Array<{
        name: string;
        value: string;
      }>;
      assert.deepEqual(shown, { name: "command", value: cmd });
      assert.deepEqual(cwd, { name: "cwd", value: "." });
      assert.equal(asked.allowForChat, true);
      assert.match(String(asked.scope), /^[0-9a-f]{64}$/);
      const [done] = of(events, "command.completed");
      assert.equal(done!.status, "declined");
      assert.equal(done!.approval, "deny");
      assert.equal(await exists("deny", "untracked.txt"), true);
    });

  test("Allow once runs the command; the same command asks again", async () => {
    await repo("once");
    h.model.script.push(exec("git clean -fd"), reply);
    const first = await runAnswering(
      h,
      h.body({ chatId: "once" }),
      () => "allow",
    );
    const [done] = of(first.events, "command.completed");
    assert.equal(done!.status, "completed");
    assert.equal(done!.exitCode, 0);
    assert.equal(await exists("once", "untracked.txt"), false);
    const items = completed(first.events).items as Array<
      Record<string, unknown>
    >;
    assert.equal(items[0]!.type, "command");
    assert.equal(items[0]!.command, "git clean -fd");
    assert.equal(items[0]!.approval, "allow");

    h.model.script.push(exec("git clean -fd"), reply);
    const second = await runAnswering(
      h,
      h.body({ chatId: "once" }),
      () => "allow",
    );
    assert.equal(of(second.events, "approval.requested").length, 1);
  });

  test("Allow for this chat re-allows only that same command, in this run and later ones", async () => {
    await repo("chat-allow");
    h.model.script.push(
      exec("git clean -fd"),
      exec("git clean -fd"),
      exec("git clean -n"),
      reply,
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "chat-allow" }),
      (a) =>
        (a.params as Array<{ value: string }>)[0]!.value === "git clean -fd"
          ? "allow_for_chat"
          : "deny",
    );
    const resolved = of(events, "approval.resolved");
    assert.deepEqual(
      resolved.map((r) => [r.decision, r.auto]),
      [
        ["allow_for_chat", false],
        ["allow_for_chat", true], // the same command, no card
        ["deny", false], // a different command asked
      ],
    );
    const scope = String(resolved[0]!.scope);
    assert.equal(resolved[1]!.scope, scope);
    assert.equal(of(events, "approval.requested").length, 2);

    // A later run carrying the platform's record of the allow.
    h.model.script.push(exec("git clean -fd"), reply);
    const later = await runAnswering(
      h,
      h.body({ chatId: "chat-allow", codingApprovals: { commands: [scope] } }),
      () => "deny",
    );
    assert.equal(of(later.events, "approval.requested").length, 0);
    assert.equal(of(later.events, "approval.resolved")[0]!.auto, true);
  });

  test("a command the model asks to run outside the sandbox is refused without a card", async () => {
    h.model.script.push(
      exec("touch ../escaped.txt", {
        sandbox_permissions: "require_escalated",
        justification: "need it",
      }),
      reply,
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "escalate" }),
      () => "allow",
    );
    assert.equal(of(events, "approval.requested").length, 0);
    assert.equal(await exists("escalate", "../escaped.txt"), false);
    assert.match(lastOutput(), /sandbox_approval/);
  });

  test("git push always asks, offers no Allow for this chat, and an allow-for-chat answer counts once", async () => {
    h.model.script.push(
      exec("git push origin main"),
      exec("git push origin main"),
      reply,
    );
    const { events, answers } = await runAnswering(
      h,
      h.body({ chatId: "push" }),
      () => "allow_for_chat",
    );
    const asked = of(events, "approval.requested");
    assert.equal(asked.length, 2, "the second push asked again");
    assert.equal(asked[0]!.tool, "push");
    assert.equal(asked[0]!.allowForChat, false);
    assert.equal(asked[0]!.scope, undefined);
    assert.deepEqual(await answers[0]!.json(), { decision: "allow" });
    assert.deepEqual(
      of(events, "approval.resolved").map((r) => r.decision),
      ["allow", "allow"],
    );
  });

  test("file changes inside the chat apply without a card", async () => {
    await mkdir(workspace("edit"), { recursive: true });
    await writeFile(join(workspace("edit"), "notes.txt"), "old\n");
    h.model.script.push(
      patch(
        "*** Begin Patch\n*** Update File: notes.txt\n@@\n-old\n+new\n*** Add File: src/app.py\n+print('hi')\n*** End Patch\n",
      ),
      patch("*** Begin Patch\n*** Delete File: notes.txt\n*** End Patch\n"),
      reply,
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "edit" }),
      () => "deny",
    );
    assert.equal(of(events, "approval.requested").length, 0);
    const changes = of(events, "file_change.completed");
    assert.deepEqual(
      changes.map((c) => c.status),
      ["completed", "completed"],
    );
    assert.deepEqual(changes[0]!.files, [
      { path: "notes.txt", kind: "update" },
      { path: "src/app.py", kind: "add" },
    ]);
    assert.equal(await exists("edit", "notes.txt"), false);
    assert.equal(
      await readFile(join(workspace("edit"), "src/app.py"), "utf8"),
      "print('hi')\n",
    );
  });

  test("a patch that writes outside the chat is refused without a card", async () => {
    h.model.script.push(
      patch(
        "*** Begin Patch\n*** Add File: ../outside.md\n+hi\n*** End Patch\n",
      ),
      reply,
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "edit-out" }),
      () => "allow",
    );
    assert.equal(of(events, "approval.requested").length, 0);
    assert.equal(await exists("edit-out", "../outside.md"), false);
    assert.match(lastOutput(), /patch rejected: writing outside/);
  });

  test("an unanswered card expires and the command does not run", async () => {
    const short = new Harness({ coding: true, limits: { approvalMs: 10_000 } });
    await short.start();
    try {
      await mkdir(
        join(short.stateDir, "t", "tenant1", "c", "expire", "workspace"),
        { recursive: true },
      );
      await git(
        join(short.stateDir, "t", "tenant1", "c", "expire", "workspace"),
        "init",
        "-q",
      );
      short.model.script.push(exec("git clean -fd"), reply);
      const body = short.body({ chatId: "expire" });
      (body as Record<string, unknown>).limits = { approvalMs: 10_000 };
      const { events } = await runAnswering(short, body, () => null);
      assert.equal(of(events, "approval.resolved")[0]!.decision, "expired");
      assert.equal(of(events, "command.completed")[0]!.status, "declined");
    } finally {
      await short.close();
    }
  });

  test("stop while a card is open cancels it", async () => {
    await repo("stop");
    h.model.script.push(exec("git clean -fd"), reply);
    const body = h.body({ chatId: "stop" });
    const res = await h.post("/v1/runs", body);
    const events = await readSse(res, async (event) => {
      if (event.type === "approval.requested")
        await h.stop(String(body.runId), {
          tenantId: "tenant1",
          chatId: "stop",
        });
    });
    assert.equal(of(events, "approval.resolved")[0]!.decision, "cancelled");
    assert.equal(completed(events).status, "stopped");
    assert.equal(await exists("stop", "untracked.txt"), true);
  });

  test("a command with hidden characters is declined without a card", async () => {
    h.model.script.push(exec("git clean -fd a\u202Etxt.exe"), reply);
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "hidden" }),
      () => "allow",
    );
    assert.equal(of(events, "approval.requested").length, 0);
    assert.equal(of(events, "command.completed")[0]!.status, "declined");
    assert.ok(
      h.logs.some(
        (l) =>
          l.event === "approval_declined" &&
          l.fields.reason === "hidden_characters",
      ),
    );
  });

  test("command output streams and is kept on the item", async () => {
    await mkdir(workspace("out"), { recursive: true });
    await writeFile(join(workspace("out"), "a.txt"), "alpha\n");
    h.model.script.push(exec("cat a.txt"), reply);
    const events = await h.run(h.body({ chatId: "out" }));
    const [started] = of(events, "command.started");
    assert.equal(started!.command, "cat a.txt");
    const items = completed(events).items as Array<Record<string, unknown>>;
    assert.equal(items[0]!.output, "alpha\n");
    assert.equal(items[0]!.status, "completed");
  });
  test("a patch shows progress while the model writes it, then becomes its file change", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
    const input = `*** Begin Patch\n*** Add File: guide.md\n${body}\n*** End Patch\n`;
    h.model.script.push(
      { kind: "custom", name: "apply_patch", input, stream: 24, delayMs: 40 },
      reply,
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "progress" }),
      () => "allow",
    );
    assert.equal(completed(events).status, "completed");
    const types = events.map((e) => e.type);
    const progress = of(events, "file_change.progress");
    assert.ok(progress.length >= 2, `progress updates: ${progress.length}`);
    const [started] = of(events, "file_change.started");
    assert.ok(started, "the file change started");
    let text = "";
    for (const p of progress) {
      assert.equal(p.itemId, started.itemId);
      assert.deepEqual(p.files, [{ path: "guide.md", kind: "add" }]);
      // A new file's text arrives in pieces, each starting where the last
      // one ended.
      const preview = p.preview as Record<string, unknown> | undefined;
      if (!preview) continue;
      assert.equal(preview.path, "guide.md");
      assert.equal(preview.offset, text.length);
      assert.equal(preview.truncated, false);
      text += String(preview.text);
    }
    assert.ok(text.length > 0, "the text streamed");
    assert.ok(
      `${body.replaceAll("+", "")}\n`.startsWith(text),
      "the streamed text is the file's text so far",
    );
    const lines = progress.map((p) => p.lines as number);
    assert.deepEqual(
      [...lines].sort((a, b) => a - b),
      lines,
      "lines only grow",
    );
    assert.ok(lines.at(-1)! <= 40 && lines.at(-1)! > lines[0]!);
    // Progress comes first and stops once the file change item exists.
    assert.ok(
      types.lastIndexOf("file_change.progress") <
        types.indexOf("file_change.started"),
    );
    // Not an item: the completed run lists the file change only.
    const items = completed(events).items as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((i) => i.type),
      ["file_change", "reply"],
    );
    assert.ok(await exists("progress", "guide.md"));

    // The platform can list and read the file the run made.
    const query = "tenantId=tenant1";
    const listed = await h.fetch(`/v1/chats/progress/files?${query}`);
    assert.equal(listed.status, 200);
    const { files } = (await listed.json()) as {
      files: Array<{ path: string; size: number }>;
    };
    assert.deepEqual(
      files.map((f) => f.path),
      ["guide.md"],
    );
    const read = await h.fetch(
      `/v1/chats/progress/file?${query}&path=guide.md`,
    );
    assert.equal(read.status, 200);
    assert.equal(await read.text(), `${body.replaceAll("+", "")}\n`);
    const escape = await h.fetch(
      `/v1/chats/progress/file?${query}&path=..%2Fchat.json`,
    );
    assert.equal(escape.status, 400);
    const unauthenticated = await fetch(
      `${h.base}/v1/chats/progress/files?${query}`,
    );
    assert.equal(unauthenticated.status, 401);
  });

  test("progress for a patch Codex rejects ends when the model moves on", async () => {
    // No "*** End Patch": Codex refuses it and tells the model, with no item.
    const input = "*** Begin Patch\n*** Add File: broken.md\n+one\n+two\n";
    h.model.script.push(
      { kind: "custom", name: "apply_patch", input, stream: 8 },
      reply,
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "rejected" }),
      () => "allow",
    );
    assert.equal(completed(events).status, "completed");
    const progress = of(events, "file_change.progress");
    assert.ok(progress.length >= 1, "progress was shown");
    assert.deepEqual(progress.at(-1), {
      itemId: progress[0]!.itemId,
      ended: true,
    });
    assert.equal(of(events, "file_change.started").length, 0);
    assert.equal(await exists("rejected", "broken.md"), false);
    const types = events.map((e) => e.type);
    assert.ok(
      types.lastIndexOf("file_change.progress") < types.indexOf("text.delta"),
      "ended before the reply streams",
    );
  });
});
