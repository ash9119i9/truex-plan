// End-to-end: drives the real pinned Codex binary through BusinessRuntime and
// ThreadManager with a scripted fake Responses API provider, exercising the
// conversation workspace tools (and run_script with an injected runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BusinessRuntime } from "../../src/runtime/business-runtime";
import { ThreadManager } from "../../src/threads/manager";
import type {
  ScriptResult,
  ScriptRunOptions,
  ScriptRunner,
} from "../../src/tools/scripts";

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
const skip = !existsSync(binary);

async function until(predicate: () => boolean, ms = 60000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runtime timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A scripted step: call a tool, or end the turn with an assistant message.
type Step = { call: string; args: any } | { say: string };

/** Every tool name offered to the model, including tools inside namespaces. */
function toolNames(tools: any[] = []): string[] {
  return tools.flatMap((t: any) => [
    ...(typeof t?.name === "string" ? [t.name] : []),
    ...(Array.isArray(t?.tools) ? toolNames(t.tools) : []),
  ]);
}
/** The namespace wrapping a tool, if the runtime sends it inside one. */
function namespaceOf(tools: any[] = [], name: string): string | undefined {
  return tools.find(
    (t: any) =>
      Array.isArray(t?.tools) && t.tools.some((e: any) => e?.name === name),
  )?.name;
}
/** Text of the function_call_output for callId as the model received it. */
function outputOf(body: any, callId: string): string {
  const item = body.input?.find(
    (i: any) => i.type === "function_call_output" && i.call_id === callId,
  );
  assert.ok(item, `No function_call_output for ${callId}`);
  const out = item.output;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return out.map((c: any) => c.text ?? "").join("");
  if (Array.isArray(out?.content))
    return out.content.map((c: any) => c.text ?? "").join("");
  return JSON.stringify(out);
}

/** Fake Responses API: each /responses request plays the next scripted step. */
async function fakeProvider(script: Step[]) {
  const requests: any[] = [];
  const server: Server = createServer(async (req, res) => {
    if (!req.url?.includes("/responses")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const n = requests.length,
      step = script[n - 1] ?? { say: "Done." };
    const item =
      "call" in step
        ? {
            type: "function_call",
            id: "fc_" + n,
            call_id: "call_" + n,
            name: step.call,
            ...(namespaceOf(body.tools, step.call)
              ? { namespace: namespaceOf(body.tools, step.call) }
              : {}),
            arguments: JSON.stringify(step.args),
          }
        : {
            type: "message",
            id: "msg_" + n,
            role: "assistant",
            content: [{ type: "output_text", text: step.say }],
          };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "r_" + n } },
      { type: "response.output_item.added", item },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: "r_" + n,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, requests, port: (server.address() as any).port as number };
}

async function setup(t: any, script: Step[], runner?: ScriptRunner) {
  const home = mkdtempSync(join(tmpdir(), "truex-workspace-e2e-"));
  const provider = await fakeProvider(script);
  const client = new BusinessRuntime(binary, home, 15000, runner),
    manager = new ThreadManager(client, home);
  t.after(async () => {
    manager.close();
    client.stop();
    provider.server.closeAllConnections();
    await new Promise<void>((r) => provider.server.close(() => r()));
    await new Promise((r) => setTimeout(r, 300));
    rmSync(home, { recursive: true, force: true });
  });
  const { threadId } = await manager.create({
    model: "gpt-5",
    modelProvider: "fixture",
    config: {
      "model_providers.fixture": {
        name: "fixture",
        base_url: `http://127.0.0.1:${provider.port}/v1`,
        wire_api: "responses",
        experimental_bearer_token: "fixture-key",
      },
    },
  });
  const cwd: string = JSON.parse(
    readFileSync(join(home, "business-threads", threadId + ".json"), "utf8"),
  ).cwd;
  // Sends one user turn and waits until the script has played through `upTo`
  // steps and the thread is idle again.
  const turn = async (text: string, upTo: number) => {
    await manager.message(threadId, text);
    await until(
      () =>
        provider.requests.length >= upTo &&
        manager.snapshot(threadId).state.kind === "idle",
    );
  };
  return { home, cwd, client, manager, threadId, turn, ...provider };
}

// ~3,200-line ABAP report built from four chunks.
const CHUNK_LINES = 800;
function abapChunk(part: number): string {
  const out: string[] = [];
  for (let i = 0; i < CHUNK_LINES; i++) {
    const line = part * CHUNK_LINES + i + 1;
    if (line === 1) out.push("REPORT zsales_report.");
    else if (line === 1500) out.push("  lv_totl = lv_total + ls_item-amount.");
    else if (line === 2400) out.push("FORM calc_totals USING it_items.");
    else if (line % 100 === 0) out.push("  WRITE: / sy-uline.");
    else out.push(`  " line ${line}: DATA lv_f${line} TYPE i VALUE ${line}.`);
  }
  return out.join("\n") + "\n";
}
const chunks = [0, 1, 2, 3].map(abapChunk);
const fullReport = chunks.join("");
const fixedReport = fullReport.replace(
  "  lv_totl = lv_total + ls_item-amount.",
  "  lv_total = lv_total + ls_item-amount.",
);
const report = "src/zsales_report.abap";

test(
  "workspace tools build, read, search, edit, export and confine a large ABAP report across turns",
  { skip, timeout: 180000 },
  async (t) => {
    const outside = join(tmpdir(), `truex-e2e-escape-${randomUUID()}.txt`);
    const script: Step[] = [
      // Turn 1: steps 1-5
      { call: "write_file", args: { path: "tmp/scratch.txt", content: "x\n" } },
      { call: "write_file", args: { path: report, content: chunks[0] } },
      { call: "append_file", args: { path: report, content: chunks[1] } },
      { call: "list_files", args: {} },
      { say: "Part one written." },
      // Turn 2: steps 6-19
      { call: "append_file", args: { path: report, content: chunks[2] } },
      { call: "append_file", args: { path: report, content: chunks[3] } },
      { call: "read_file", args: { path: report, offset: 1499, limit: 3 } },
      {
        call: "search_files",
        args: { pattern: "FORM calc_totals", glob: "*.abap", literal: true },
      },
      {
        call: "edit_file",
        args: {
          path: report,
          old_string: "  lv_totl = lv_total",
          new_string: "  lv_total = lv_total",
        },
      },
      {
        call: "edit_file",
        args: {
          path: report,
          old_string: "WRITE: / sy-uline.",
          new_string: "WRITE: / sy-vline.",
        },
      },
      {
        call: "write_file",
        args: { path: "../../etc/passwd", content: "pwned\n" },
      },
      { call: "write_file", args: { path: outside, content: "pwned\n" } },
      { call: "read_file", args: { path: "../../../../etc/hosts" } },
      { call: "list_files", args: {} },
      {
        call: "export_workspace_file",
        args: { path: report, name: "ZSALES_REPORT.abap" },
      },
      { call: "conversation_files", args: {} },
      { call: "read_file", args: { path: report, offset: 3200 } },
      { say: "ZSALES_REPORT.abap is available under Documents." },
    ];
    const s = await setup(t, script);
    const started = Date.now();
    const work = join(s.cwd, "work");
    const out = (step: number) => outputOf(s.requests[step], "call_" + step);

    await s.turn("Write the first half of the sales report.", 5);
    const turn1Ms = Date.now() - started;
    assert.equal(s.requests.length, 5);

    // 1. Tool list: workspace tools offered, no shell/exec/patch/run_script.
    const names = toolNames(s.requests[0].tools);
    for (const name of [
      "write_file",
      "append_file",
      "edit_file",
      "read_file",
      "list_files",
      "search_files",
      "delete_file",
      "export_workspace_file",
    ])
      assert.ok(names.includes(name), `${name} must be offered`);
    for (const name of [
      "run_script",
      "shell",
      "shell_command",
      "exec_command",
      "apply_patch",
      "write_stdin",
      "local_shell",
    ])
      assert.ok(!names.includes(name), `${name} must not be offered`);
    t.diagnostic(
      `write_file namespace: ${namespaceOf(s.requests[0].tools, "write_file") ?? "(plain function)"}`,
    );

    // Turn 1 results: scratch file present in turn 1 listing.
    assert.match(out(1), /tmp\/scratch\.txt/);
    assert.match(out(3), /"appendedBytes":/);
    assert.match(out(4), /tmp\/scratch\.txt/);
    assert.match(out(4), /src\/zsales_report\.abap/);

    // 4. tmp/ is cleared once the turn completes.
    await until(() => !existsSync(join(work, "tmp")), 15000);
    assert.ok(existsSync(join(work, report)));

    const t2 = Date.now();
    await s.turn("Finish the report, fix it and export it.", 19);
    const turn2Ms = Date.now() - t2;
    assert.equal(s.requests.length, 19);

    // 2. Large file assembled over two turns; offset/limit read.
    const read = JSON.parse(out(8));
    assert.equal(read.totalLines, 3200);
    assert.equal(read.startLine, 1499);
    assert.equal(read.endLine, 1501);
    assert.equal(read.truncated, true);
    assert.equal(read.nextOffset, 1502);
    assert.equal(
      read.content,
      [
        `  1499\t  " line 1499: DATA lv_f1499 TYPE i VALUE 1499.`,
        `  1500\t  lv_totl = lv_total + ls_item-amount.`,
        `  1501\t  " line 1501: DATA lv_f1501 TYPE i VALUE 1501.`,
      ].join("\n"),
    );
    const search = JSON.parse(out(9));
    assert.deepEqual(search.matches, [
      `${report}:2400:FORM calc_totals USING it_items.`,
    ]);
    assert.equal(JSON.parse(out(10)).replacements, 1);
    // Non-unique old_string: failure text reaches the model, turn continues.
    assert.match(out(11), /old_string matches 30 times/);
    assert.doesNotMatch(out(11), /"replacements"/);

    // 3. Path escapes are refused and nothing lands outside the workspace.
    assert.match(out(12), /cannot contain '\.\.'/);
    assert.match(out(13), /not an absolute path/);
    assert.match(out(14), /cannot contain '\.\.'/);
    assert.ok(!existsSync(outside));
    assert.ok(!existsSync(join(s.home, "business-workspaces", "etc")));
    assert.ok(!existsSync(join(s.cwd, "etc")));

    // 4. Turn 2 listing: scratch gone, report remains.
    assert.doesNotMatch(out(15), /scratch/);
    assert.match(out(15), /src\/zsales_report\.abap/);

    // 5. Export publishes the edited report as a conversation file.
    assert.match(out(16), /ZSALES_REPORT\.abap/);
    assert.match(out(17), /ZSALES_REPORT\.abap/);
    const files = await s.client.files.list(s.threadId);
    const exported = files.find((f: any) => f.name === "ZSALES_REPORT.abap");
    assert.ok(exported, "exported file must be listed");
    const stored = await s.client.files.get(s.threadId, exported!.id);
    assert.equal(stored.data.toString("utf8"), fixedReport);
    assert.equal(readFileSync(join(work, report), "utf8"), fixedReport);
    const tail = JSON.parse(out(18));
    assert.equal(tail.content, "  3200\t  WRITE: / sy-uline.");
    assert.equal(tail.truncated, false);
    assert.equal(tail.nextOffset, null);

    // No host paths of the runtime home leak through tool outputs.
    for (const body of s.requests)
      for (const item of body.input ?? [])
        if (item.type === "function_call_output")
          assert.ok(
            !JSON.stringify(item).includes(s.home),
            `host path leaked in ${item.call_id}`,
          );
    t.diagnostic(
      `turn1 ${turn1Ms}ms (5 requests), turn2 ${turn2Ms}ms (14 requests), report ${Buffer.byteLength(fullReport)} bytes`,
    );
  },
);

test(
  "run_script is offered with an injected runner and its result reaches the model",
  { skip, timeout: 120000 },
  async (t) => {
    const runs: ScriptRunOptions[] = [];
    const runner: ScriptRunner = {
      async run(opts): Promise<ScriptResult> {
        runs.push(opts);
        return {
          exitCode: 0,
          stdout: "hello from sandbox 42\n",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 7,
        };
      },
    };
    const s = await setup(
      t,
      [
        {
          call: "write_file",
          args: { path: "tmp/hello.py", content: "print('hello')\n" },
        },
        {
          call: "run_script",
          args: { language: "python", path: "tmp/hello.py", args: ["42"] },
        },
        { call: "run_script", args: { language: "python", path: "../x.py" } },
        { say: "The script printed hello." },
      ],
      runner,
    );
    await s.turn("Run a hello script.", 4);
    assert.equal(s.requests.length, 4);
    assert.ok(toolNames(s.requests[0].tools).includes("run_script"));
    assert.doesNotMatch(
      JSON.stringify(s.requests[0].tools),
      /"(exec_command|shell_command|apply_patch)"/,
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].path, "tmp/hello.py");
    assert.deepEqual(runs[0].args, ["42"]);
    assert.equal(runs[0].language, "python");
    assert.equal(runs[0].workRoot, join(s.cwd, "work"));
    const result = outputOf(s.requests[2], "call_2");
    assert.match(result, /hello from sandbox 42/);
    assert.match(result, /"exitCode":0/);
    assert.ok(!result.includes(s.home), "host path leaked in run_script");
    const escape = outputOf(s.requests[3], "call_3");
    assert.doesNotMatch(escape, /hello from sandbox/);
    assert.ok(!escape.includes(s.home), "host path leaked in script error");
  },
);
