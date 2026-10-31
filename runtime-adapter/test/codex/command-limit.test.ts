import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { DEFAULT_LIMITS, loadConfig } from "../../src/config";
import { DOCUMENT_INSTRUCTIONS } from "../../src/codex/coding";
import { Harness, completed, runAnswering } from "../support/harness";
import type { Behavior } from "../support/model-fixture";

// A reply that keeps running commands stops as COMMAND_LIMIT, on the real
// pinned Codex: a model retrying tools that aren't there (pandoc, pip, brew)
// otherwise spends tokens until it gives up on its own (one chat: 36
// commands, 19 failed, 749k tokens).

const exec = (cmd: string): Behavior => ({
  kind: "call",
  name: "exec_command",
  args: { cmd },
});

describe("command limits (real Codex)", () => {
  const h = new Harness({
    coding: true,
    limits: { maxFailedCommands: 3, maxCommands: 5 },
  });
  before(() => h.start());
  after(() => h.close());
  beforeEach(() => {
    h.model.script.length = 0;
    h.model.router = undefined;
  });
  // The counts the adapter logged when it stopped this reply. Exact, unlike
  // the model request count: Codex may already be asking the model for the
  // next step when the stop arrives.
  const lastStop = () => {
    const log = h.logs.filter((l) => l.event === "command_limit").at(-1);
    return log && { c: log.fields.commands, f: log.fields.failedCommands };
  };

  test("a reply stops as COMMAND_LIMIT at the failed-command limit", async () => {
    h.model.script.push(
      exec("pandoc a.md -o a.pdf"),
      exec("false"),
      exec("exit 3"),
      // Never reached: the reply stopped at the third failure.
      exec("echo never"),
      { kind: "reply", text: "Done." },
    );
    const events = await h.run(h.body({ chatId: "limit1" }));
    const done = completed(events);
    assert.equal(done.status, "failed");
    const error = done.error as { code: string; retryable: boolean };
    assert.equal(error.code, "COMMAND_LIMIT");
    assert.equal(error.retryable, false);
    // Stopped at the third failure, not later.
    assert.deepEqual(lastStop(), { c: 3, f: 3 });
    h.model.script.length = 0;
  });

  // A declined command has no exit code: only its status says it failed.
  test("declined commands count as failed", async () => {
    h.model.script.push(
      exec("git push origin main"),
      exec("git push origin main"),
      exec("git push origin main"),
      exec("echo never"),
      { kind: "reply", text: "Done." },
    );
    const { events } = await runAnswering(
      h,
      h.body({ chatId: "limit-declined" }),
      () => "deny",
    );
    const done = completed(events);
    assert.equal(done.status, "failed", JSON.stringify(done.error));
    assert.equal((done.error as { code: string }).code, "COMMAND_LIMIT");
    h.model.script.length = 0;
  });

  test("failures under the limit don't stop the reply", async () => {
    h.model.script.push(exec("false"), exec("false"), exec("true"), {
      kind: "reply",
      text: "Done.",
    });
    const events = await h.run(h.body({ chatId: "limit2" }));
    assert.equal(completed(events).status, "completed");
  });

  test("the limit is per reply: the next reply starts from zero", async () => {
    h.model.script.push(exec("false"), exec("false"), {
      kind: "reply",
      text: "One.",
    });
    assert.equal(
      completed(await h.run(h.body({ chatId: "limit3" }))).status,
      "completed",
    );
    h.model.script.push(exec("false"), exec("false"), {
      kind: "reply",
      text: "Two.",
    });
    assert.equal(
      completed(await h.run(h.body({ chatId: "limit3" }))).status,
      "completed",
    );
  });

  test("a reply stops as COMMAND_LIMIT at the total-command limit, even when every command succeeds", async () => {
    for (let i = 0; i < 7; i++) h.model.script.push(exec(`echo ${i}`));
    h.model.script.push({ kind: "reply", text: "Done." });
    const events = await h.run(h.body({ chatId: "limit4" }));
    const done = completed(events);
    assert.equal(done.status, "failed");
    assert.equal((done.error as { code: string }).code, "COMMAND_LIMIT");
    assert.deepEqual(lastStop(), { c: 5, f: 0 });
    h.model.script.length = 0;
  });

  test("the model is told which document libraries exist and what can't be installed", async () => {
    h.model.script.push({ kind: "reply", text: "Hi." });
    await h.run(h.body({ chatId: "limit5" }));
    const text = JSON.stringify(h.model.lastRequest().body);
    for (const part of [
      "python-docx",
      "openpyxl",
      "python-pptx",
      "reportlab",
      "pypdf",
      "no pip, brew or apt",
      "pandoc, LibreOffice",
      "If an approach fails twice",
      "even if earlier instructions say you have no files or code execution",
    ])
      assert.ok(text.includes(part), part);
    assert.ok(text.includes(DOCUMENT_INSTRUCTIONS.slice(0, 60)));
  });
});

// A helper's commands count against the lead's reply: a helper retrying
// missing tools stops the reply just as the lead would.
describe("command limits with helpers (real Codex)", () => {
  const h = new Harness({
    coding: true,
    limits: { maxFailedCommands: 3, maxCommands: 50, stopMs: 3000 },
  });
  before(() => h.start());
  after(() => h.close());

  const collab = (name: string, args: unknown): Behavior => ({
    kind: "call",
    name,
    namespace: "collaboration",
    args,
  });
  // A helper's request carries the task the lead sent it.
  const isChild = (body: Record<string, unknown>) =>
    ((body.input as Array<Record<string, unknown>> | undefined) ?? []).some(
      (i) => i.type === "agent_message" && i.author === "/root",
    );

  test("a helper's failed commands stop the reply as COMMAND_LIMIT", async () => {
    const lead: Behavior[] = [
      collab("spawn_agent", {
        task_name: "pdf",
        message: "Task pdf",
        fork_turns: "none",
      }),
      collab("wait_agent", { timeout_ms: 15_000 }),
      { kind: "reply", text: "lead done" },
    ];
    const child: Behavior[] = [
      exec("pandoc a.md -o a.pdf"),
      exec("false"),
      exec("exit 2"),
      exec("echo never"),
    ];
    let childCalls = 0;
    h.model.router = (b) => {
      if (isChild(b)) {
        childCalls += 1;
        return child.shift() ?? { kind: "reply", text: "helper done" };
      }
      return lead.shift() ?? { kind: "reply", text: "lead done" };
    };
    const events = await h.run(
      h.body({ chatId: "limit-help1", subAgents: { maxConcurrent: 1 } }),
    );
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "failed", JSON.stringify(done.error));
    assert.equal((done.error as { code: string }).code, "COMMAND_LIMIT");
    // The helper's fourth command was never run.
    assert.ok(childCalls <= 4, `helper model calls: ${childCalls}`);
    assert.ok(child.length >= 1, "the helper was stopped before 'echo never'");
  });
});

describe("command limit settings", () => {
  const base = {
    RUNTIME_ADAPTER_TOKEN: "t".repeat(32),
    RUNTIME_STATE_DIR: "/tmp/adapter-state",
    RUNTIME_CODEX_BINARY: process.execPath,
  };

  test("default to 12 failed and 120 total", () => {
    const { limits } = loadConfig(base);
    assert.equal(limits.maxFailedCommands, 12);
    assert.equal(limits.maxCommands, 120);
    assert.equal(DEFAULT_LIMITS.maxFailedCommands, 12);
  });

  test("are read from the environment", () => {
    const { limits } = loadConfig({
      ...base,
      RUNTIME_MAX_FAILED_COMMANDS: "20",
      RUNTIME_MAX_COMMANDS: "100",
    });
    assert.equal(limits.maxFailedCommands, 20);
    assert.equal(limits.maxCommands, 100);
  });

  test("refuse a total limit below the failure limit", () => {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          RUNTIME_MAX_FAILED_COMMANDS: "12",
          RUNTIME_MAX_COMMANDS: "5",
        }),
      /RUNTIME_MAX_COMMANDS must be at least RUNTIME_MAX_FAILED_COMMANDS/,
    );
    // Equal is allowed.
    assert.equal(
      loadConfig({
        ...base,
        RUNTIME_MAX_FAILED_COMMANDS: "5",
        RUNTIME_MAX_COMMANDS: "5",
      }).limits.maxCommands,
      5,
    );
  });

  for (const [name, value] of [
    ["RUNTIME_MAX_FAILED_COMMANDS", "0"],
    ["RUNTIME_MAX_FAILED_COMMANDS", "1.5"],
    ["RUNTIME_MAX_FAILED_COMMANDS", "abc"],
    ["RUNTIME_MAX_COMMANDS", "-1"],
    ["RUNTIME_MAX_COMMANDS", "10001"],
  ] as const)
    test(`refuse ${name}=${value}`, () => {
      assert.throws(
        () => loadConfig({ ...base, [name]: value }),
        new RegExp(`${name} must be a whole number`),
      );
    });
});
