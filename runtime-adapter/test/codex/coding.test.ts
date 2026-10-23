import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Harness, completed } from "../support/harness";
import type { Behavior } from "../support/model-fixture";

// The coding profile on the real pinned Codex (RUNTIME_CODING_ENABLED=1):
// which tools the model gets, that the catalog lifts the context-window
// clamp, and that every command stays inside the chat's sandbox. Approval
// relaying is covered in coding-approvals.test.ts.

const exec = (cmd: string): Behavior => ({
  kind: "call",
  name: "exec_command",
  args: { cmd },
});

function toolNames(body: Record<string, unknown>): string[] {
  return ((body.tools ?? []) as Array<Record<string, unknown>>)
    .map((tool) =>
      tool.type === "function"
        ? String(tool.name)
        : `${tool.type}:${tool.name}`,
    )
    .sort();
}

// What the command printed, as Codex reported it back to the model.
function lastToolOutput(h: Harness): string {
  const input = h.model.lastRequest().body.input as Array<
    Record<string, unknown>
  >;
  const output = input
    .filter((item) => item.type === "function_call_output")
    .at(-1);
  return String(output?.output ?? "");
}

describe("coding profile (real Codex)", () => {
  const h = new Harness({ coding: true });
  before(() => h.start());
  after(() => h.close());

  const chatRoot = (chatId: string) =>
    join(h.stateDir, "t", "tenant1", "c", chatId);

  test("the model gets exec_command, write_stdin and apply_patch, and the coding instructions", async () => {
    const events = await h.run(h.body({ chatId: "code1" }));
    assert.equal(completed(events).status, "completed");
    const request = h.model.lastRequest().body;
    assert.deepEqual(toolNames(request), [
      "custom:apply_patch",
      "exec_command",
      "write_stdin",
    ]);
    const text = JSON.stringify(request);
    assert.ok(text.includes("AGENT_PROMPT_MARKER"), "agent prompt kept");
    assert.ok(text.includes("Never mention workspaces"), "coding instructions");
    assert.doesNotMatch(
      JSON.stringify(request.input),
      /environment_context|permissions instructions/i,
      "Codex adds no environment or permissions block",
    );
    assert.ok(!text.includes(h.stateDir), "no host paths in the prompt");
  });

  test("no package.json is written when no directory above the state directory has one", () => {
    assert.ok(!existsSync(join(h.stateDir, "package.json")));
  });

  test("the profile's files are written to the chat's Codex home", async () => {
    const home = join(chatRoot("code1"), "home");
    const rules = await readFile(join(home, "rules", "default.rules"), "utf8");
    // Only prompt rules: on-request needs no allow list for reads.
    assert.doesNotMatch(rules, /decision = "allow"/);
    for (const pattern of [
      '"git", "push"',
      '"git", "reset", "--hard"',
      '"git", "clean"',
    ])
      assert.match(
        rules,
        new RegExp(`\\[${pattern}\\],\\s*decision = "prompt"`),
        pattern,
      );
    const catalog = JSON.parse(
      await readFile(join(home, "model-catalog.json"), "utf8"),
    ) as { models: Array<Record<string, unknown>> };
    assert.equal(catalog.models[0]!.slug, "fixture-model");
    assert.equal(catalog.models[0]!.context_window, 100_000);
  });

  test("the catalog lifts Codex's 272k fallback clamp on the context window", async () => {
    const body = h.body({ chatId: "code-big" });
    (body.model as Record<string, unknown>).contextWindow = 1_000_000;
    (body.model as Record<string, unknown>).autoCompactTokenLimit = 900_000;
    const events = await h.run(body);
    const usage = completed(events).usage as { contextWindow: number };
    // 95% of the model's own window, not 95% of 272k (258.4k).
    assert.equal(usage.contextWindow, 950_000);
  });

  test("a read command runs without asking and returns its output", async () => {
    await mkdir(join(chatRoot("code1"), "workspace"), { recursive: true });
    await writeFile(join(chatRoot("code1"), "workspace", "a.txt"), "alpha\n");
    h.model.script.push(exec("cat a.txt"), { kind: "reply", text: "Read it." });
    const events = await h.run(h.body({ chatId: "code1" }));
    assert.equal(completed(events).status, "completed");
    assert.ok(!events.some((e) => e.type === "approval.requested"));
    assert.match(lastToolOutput(h), /exited with code 0[\s\S]*alpha/);
    // Two model calls (the command, then the reply): the turn counts both.
    const usage = completed(events).usage as {
      last: Record<string, number>;
      turn: Record<string, number>;
    };
    assert.equal(usage.last.inputTokens, 20);
    assert.equal(usage.turn.inputTokens, 40);
    assert.equal(usage.turn.outputTokens, 20);
  });

  // Shells write heredocs to a temp file first, and /tmp is denied. bash uses
  // TMPDIR; zsh (the macOS login shell) uses TMPPREFIX, default /tmp/zsh.
  for (const shell of ["/bin/bash", "/bin/zsh"]) {
    test(
      `a ${shell} heredoc writes the file inside the sandbox`,
      {
        skip: !existsSync(shell) && `${shell} not installed`,
      },
      async () => {
        const file = `heredoc-${shell.split("/").pop()}.txt`;
        h.model.script.push(
          {
            kind: "call",
            name: "exec_command",
            args: {
              cmd: `cat > ${file} << 'EOF'\nline one\nEOF`,
              shell,
              login: true,
            },
          },
          { kind: "reply", text: "Wrote it." },
        );
        const events = await h.run(h.body({ chatId: "code1" }));
        assert.equal(completed(events).status, "completed");
        const output = lastToolOutput(h);
        assert.doesNotMatch(
          output,
          /can't create temp file|not permitted/,
          output,
        );
        assert.equal(
          await readFile(join(chatRoot("code1"), "workspace", file), "utf8"),
          "line one\n",
        );
      },
    );
  }

  test("an uploaded file lands in uploads/ and the model reads it without asking", async () => {
    const data = "quarterly,total\nQ3,42\n";
    const digest = createHash("sha256").update(data).digest("hex");
    const put = (name: string, query: string, body: string, type?: string) =>
      h.fetch(
        `/v1/chats/upload1/uploads/${encodeURIComponent(name)}?tenantId=tenant1&${query}`,
        {
          method: "PUT",
          headers: { "content-type": type ?? "application/octet-stream" },
          body,
        },
      );
    const res = await put("Sales Q3.csv", `sha256=${digest}`, data);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(
      { ...((await res.json()) as Record<string, unknown>), modifiedAt: 0 },
      { path: "uploads/Sales Q3.csv", size: data.length, modifiedAt: 0 },
    );
    // Wrong type, wrong digest, an escaping name, no token.
    assert.equal(
      (await put("a.csv", `sha256=${digest}`, data, "text/csv")).status,
      400,
    );
    assert.equal(
      (await put("a.csv", `sha256=${"0".repeat(64)}`, data)).status,
      400,
    );
    assert.equal((await put("../a.csv", `sha256=${digest}`, data)).status, 400);
    const anonymous = await fetch(
      `${h.base}/v1/chats/upload1/uploads/a.csv?tenantId=tenant1&sha256=${digest}`,
      { method: "PUT", body: data },
    );
    assert.equal(anonymous.status, 401);

    h.model.script.push(exec("cat 'uploads/Sales Q3.csv'"), {
      kind: "reply",
      text: "Read it.",
    });
    const events = await h.run(h.body({ chatId: "upload1" }));
    assert.equal(completed(events).status, "completed");
    assert.ok(!events.some((e) => e.type === "approval.requested"));
    assert.match(lastToolOutput(h), /exited with code 0[\s\S]*Q3,42/);
    const listed = (await (
      await h.fetch("/v1/chats/upload1/files?tenantId=tenant1")
    ).json()) as { files: Array<{ path: string }> };
    assert.deepEqual(
      listed.files.map((f) => f.path),
      ["uploads/Sales Q3.csv"],
    );
  });

  test("an attached image reaches the model as an image, labelled by its workspace path", async () => {
    // 1×1 PNGs, one red, one blue.
    const red = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    const blue = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
      "base64",
    );
    const upload = (bytes: Buffer) =>
      h.fetch(
        `/v1/chats/image1/uploads/chart.png?tenantId=tenant1&sha256=${createHash("sha256").update(bytes).digest("hex")}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes),
        },
      );
    const images = (body: Record<string, unknown>) =>
      (body.input as Array<{ content?: Array<Record<string, unknown>> }>)
        .flatMap((item) => item.content ?? [])
        .filter((part) => part.type === "input_image")
        .map((part) => String(part.image_url));
    assert.equal((await upload(red)).status, 200);

    const first = await h.run(
      h.body({
        chatId: "image1",
        input: {
          text: "What colour is it?",
          clientMessageId: "msg_image1",
          images: ["uploads/chart.png"],
        },
      }),
    );
    assert.equal(completed(first).status, "completed");
    const sent = h.model.lastRequest().body;
    const [image] = images(sent);
    assert.match(image ?? "", /^data:image\/png;base64,/);
    const text = JSON.stringify(sent);
    assert.match(text, /path=\\"uploads\/chart\.png\\"/);
    assert.ok(!text.includes(h.stateDir), "no host path reaches the model");

    // The next turn shows the image Codex kept, not a re-read of the file.
    assert.equal((await upload(blue)).status, 200);
    const threadId = String(first[0]!.data.threadId);
    await h.run(h.body({ chatId: "image1", threadId }));
    assert.deepEqual(images(h.model.lastRequest().body), [image]);
  });

  test("an attached image that is not a plain file in uploads/ fails the run before Codex sees it", async () => {
    await mkdir(join(chatRoot("image2"), "workspace", "uploads"), {
      recursive: true,
    });
    await symlink(
      join(h.stateDir, "t"),
      join(chatRoot("image2"), "workspace", "uploads", "link.png"),
    );
    const before = h.model.requests.length;
    for (const path of ["uploads/link.png", "uploads/absent.png"]) {
      const events = await h.run(
        h.body({
          chatId: "image2",
          input: {
            text: "Look",
            clientMessageId: `msg_${path.length}`,
            images: [path],
          },
        }),
      );
      assert.equal(completed(events).status, "failed", path);
    }
    assert.equal(h.model.requests.length, before);
    for (const images of [
      ["chart.png"],
      ["uploads/../x.png"],
      ["uploads/a.txt"],
      ["uploads/a.png", "uploads/a.png"],
    ]) {
      const res = await h.post(
        "/v1/runs",
        h.body({ input: { text: "x", clientMessageId: "msg_bad", images } }),
      );
      assert.equal(res.status, 400, JSON.stringify(images));
    }
  });

  test("reads outside the workspace are refused by the sandbox, even for allowed commands", async () => {
    await mkdir(chatRoot("other"), { recursive: true });
    await writeFile(join(chatRoot("other"), "secret.txt"), "OTHER_CHAT\n");
    const targets = [
      "../chat.json",
      "../home/rules/default.rules",
      join(chatRoot("other"), "secret.txt"),
      join(h.stateDir, "t"),
    ];
    for (const target of targets) {
      h.model.script.push(exec(`cat ${target}`), { kind: "reply", text: "ok" });
      await h.run(h.body({ chatId: "code1" }));
      const output = lastToolOutput(h);
      assert.match(output, /Operation not permitted/, target);
      assert.doesNotMatch(output, /OTHER_CHAT|threadId|prefix_rule/, target);
    }
  });
});

// A state directory inside a project, as in a local checkout: Node looks for
// package.json in every directory above a script, and the project's one is
// there but unreadable in the sandbox.
describe("coding with a project above the state directory (real Codex)", () => {
  const project = mkdtempSync(join(tmpdir(), "runtime-adapter-project-"));
  writeFileSync(join(project, "package.json"), '{ "type": "module" }\n');
  mkdirSync(join(project, "state"));
  const h = new Harness({ coding: true, stateDir: join(project, "state") });
  before(() => h.start());
  after(async () => {
    await h.close();
    await rm(project, { recursive: true, force: true });
  });

  const workspace = join(
    project,
    "state",
    "t",
    "tenant1",
    "c",
    "p1",
    "workspace",
  );

  test("node runs CommonJS and ES module scripts without reading the project's package.json", async () => {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "a.js"), "console.log(typeof require);\n");
    await writeFile(
      join(workspace, "b.js"),
      "import { sep } from 'node:path';\nconsole.log('ESM', sep);\n",
    );
    for (const [cmd, expected] of [
      ["node a.js", /exited with code 0[\s\S]*function/],
      ["node b.js", /exited with code 0[\s\S]*ESM \//],
    ] as const) {
      h.model.script.push(exec(cmd), { kind: "reply", text: "ok" });
      const events = await h.run(h.body({ chatId: "p1" }));
      assert.equal(completed(events).status, "completed");
      assert.match(lastToolOutput(h), expected, cmd);
    }
  });

  test("only the adapter's own package.json becomes readable", async () => {
    for (const target of [join(project, "package.json"), "../chat.json"]) {
      h.model.script.push(exec(`cat ${target}`), { kind: "reply", text: "ok" });
      await h.run(h.body({ chatId: "p1" }));
      assert.match(lastToolOutput(h), /not permitted/, target);
    }
    assert.match(
      await readFile(join(project, "state", "package.json"), "utf8"),
      /Truex runtime adapter/,
    );
  });
});

describe("coding off (the default)", () => {
  const h = new Harness();
  before(() => h.start());
  after(() => h.close());

  test("attached images are refused: there is no uploads/ to show them from", async () => {
    const res = await h.post(
      "/v1/runs",
      h.body({
        chatId: "plain",
        input: {
          text: "x",
          clientMessageId: "msg_plain_image",
          images: ["uploads/a.png"],
        },
      }),
    );
    assert.equal(res.status, 409);
  });

  test("uploads are refused: the model would have no way to read them", async () => {
    const res = await h.fetch(
      `/v1/chats/plain/uploads/a.txt?tenantId=tenant1&sha256=${"0".repeat(64)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "a",
      },
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UPLOADS_DISABLED");
  });

  test("runs offer no tools and write no profile files", async () => {
    await h.run(h.body({ chatId: "plain" }));
    assert.deepEqual(h.model.lastRequest().body.tools ?? [], []);
    const home = join(h.stateDir, "t", "tenant1", "c", "plain", "home");
    await assert.rejects(readFile(join(home, "model-catalog.json")));
    await assert.rejects(readFile(join(home, "rules", "default.rules")));
  });
});
