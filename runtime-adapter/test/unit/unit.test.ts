import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, DEFAULT_LIMITS, loadConfig } from "../../src/config";
import { MAX_TEXT, parseChatRef, parseStartRun } from "../../src/contract";
import { AdapterError, fromCodexErrorInfo } from "../../src/errors";
import { Run, type RunEvent } from "../../src/runtime/run";

const valid = () => ({
  runId: "run_1",
  tenantId: "t1",
  chatId: "c1",
  threadId: null,
  input: { text: "hi", clientMessageId: "m1" },
  agentPrompt: "You are helpful.",
  model: {
    modelName: "claude-sonnet-5.5",
    gatewayUrl: "https://gateway.example.com/p/abc/v1/",
    gatewayToken: "token-0123456789abcdef",
    contextWindow: 200_000,
    autoCompactTokenLimit: 160_000,
  },
});

function rejects(body: unknown, pattern: RegExp) {
  assert.throws(
    () => parseStartRun(body, DEFAULT_LIMITS),
    (error: unknown) =>
      error instanceof AdapterError &&
      error.code === "INVALID_REQUEST" &&
      pattern.test(error.message),
  );
}

describe("start-run contract", () => {
  test("accepts a valid request and normalizes the gateway URL", () => {
    const parsed = parseStartRun(valid(), DEFAULT_LIMITS);
    assert.equal(
      parsed.model.gatewayUrl,
      "https://gateway.example.com/p/abc/v1",
    );
    assert.deepEqual(parsed.limits, {
      firstResponseMs: DEFAULT_LIMITS.firstResponseMs,
      silenceMs: DEFAULT_LIMITS.silenceMs,
    });
  });

  test("refuses unknown fields, including raw Codex config", () => {
    rejects(
      { ...valid(), config: { "features.shell_tool": true } },
      /Unknown field "config"/,
    );
    rejects(
      { ...valid(), model: { ...valid().model, base_url: "x" } },
      /Unknown field/,
    );
    rejects(
      { ...valid(), input: { ...valid().input, extra: 1 } },
      /Unknown field/,
    );
  });

  test("refuses IDs that could escape the state directory", () => {
    for (const bad of ["../x", "a/b", "", "x".repeat(65), "a b", ".."])
      rejects({ ...valid(), chatId: bad }, /chatId/);
    rejects({ ...valid(), tenantId: 5 }, /tenantId/);
  });

  test("refuses a malformed thread ID", () => {
    rejects({ ...valid(), threadId: "not-a-uuid" }, /threadId/);
  });

  test("bounds message text, keeps newlines, refuses control characters", () => {
    assert.equal(
      parseStartRun(
        { ...valid(), input: { text: "a\nb\tc", clientMessageId: "m" } },
        DEFAULT_LIMITS,
      ).input.text,
      "a\nb\tc",
    );
    rejects(
      { ...valid(), input: { text: "   ", clientMessageId: "m" } },
      /input.text/,
    );
    rejects(
      {
        ...valid(),
        input: { text: "x".repeat(MAX_TEXT + 1), clientMessageId: "m" },
      },
      /input.text/,
    );
    rejects(
      { ...valid(), input: { text: "a\u202Eb", clientMessageId: "m" } },
      /control/,
    );
    rejects(
      { ...valid(), input: { text: "a\u0000b", clientMessageId: "m" } },
      /control/,
    );
  });

  test("validates model settings", () => {
    const model = valid().model;
    rejects(
      { ...valid(), model: { ...model, gatewayUrl: "ftp://x" } },
      /gatewayUrl/,
    );
    rejects(
      { ...valid(), model: { ...model, gatewayUrl: "https://u:p@x" } },
      /gatewayUrl/,
    );
    rejects(
      { ...valid(), model: { ...model, gatewayUrl: "https://x/?a=1" } },
      /gatewayUrl/,
    );
    rejects(
      { ...valid(), model: { ...model, autoCompactTokenLimit: 200_000 } },
      /below/,
    );
    rejects(
      { ...valid(), model: { ...model, reasoningEffort: "max" } },
      /reasoningEffort/,
    );
    rejects({ ...valid(), model: { ...model, modelName: "a b" } }, /modelName/);
    rejects(
      { ...valid(), model: { ...model, gatewayToken: "short" } },
      /gatewayToken/,
    );
  });

  test("callers may shorten the watchdog but never lengthen it", () => {
    const shorter = parseStartRun(
      { ...valid(), limits: { firstResponseMs: 5000, silenceMs: 4000 } },
      DEFAULT_LIMITS,
    );
    assert.deepEqual(shorter.limits, {
      firstResponseMs: 5000,
      silenceMs: 4000,
    });
    rejects(
      {
        ...valid(),
        limits: { firstResponseMs: DEFAULT_LIMITS.firstResponseMs + 1 },
      },
      /firstResponseMs/,
    );
  });

  test("error messages never echo the rejected value", () => {
    try {
      parseStartRun({ ...valid(), chatId: "SECRET_VALUE/../" }, DEFAULT_LIMITS);
      assert.fail("expected rejection");
    } catch (error) {
      assert.ok(!String((error as Error).message).includes("SECRET_VALUE"));
    }
  });

  test("chat references are validated the same way", () => {
    assert.deepEqual(parseChatRef({ tenantId: "t", chatId: "c" }), {
      tenantId: "t",
      chatId: "c",
    });
    assert.throws(() => parseChatRef({ tenantId: "t" }), AdapterError);
  });
});

describe("configuration", () => {
  test("lists every problem at once", () => {
    assert.throws(
      () =>
        loadConfig({
          RUNTIME_ADAPTER_TOKEN: "short",
          RUNTIME_STATE_DIR: "rel",
          PORT: "x",
        }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.problems.some((p) => p.includes("RUNTIME_ADAPTER_TOKEN")) &&
        error.problems.some((p) => p.includes("RUNTIME_STATE_DIR")) &&
        error.problems.some((p) => p.includes("PORT")),
    );
  });

  test("refuses a local Codex build that doesn't match the pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-adapter-config-"));
    try {
      await mkdir(join(root, ".runtime"));
      await writeFile(
        join(root, "codex.lock.json"),
        JSON.stringify({ revision: "aaa", binary: "codex" }),
      );
      await writeFile(
        join(root, ".runtime/codex-build.json"),
        JSON.stringify({ revision: "bbb" }),
      );
      assert.throws(
        () =>
          loadConfig(
            { RUNTIME_ADAPTER_TOKEN: "x".repeat(32), RUNTIME_STATE_DIR: root },
            root,
          ),
        /does not match codex.lock.json/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defaults to loopback and the pinned binary", () => {
    const config = loadConfig({
      RUNTIME_ADAPTER_TOKEN: "x".repeat(32),
      RUNTIME_STATE_DIR: "/tmp/x",
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4400);
    assert.match(
      config.codexBinary,
      /vendor\/codex\/codex-rs\/target\/debug\/codex$/,
    );
  });
});

describe("run buffer", () => {
  function collect(run: Run, after: number) {
    const events: RunEvent[] = [];
    let ended = false;
    const unsubscribe = run.subscribe(after, {
      send: (e) => events.push(e),
      end: () => (ended = true),
    });
    return { events, ended: () => ended, unsubscribe };
  }

  test("replays after the cursor and continues live with no gap", () => {
    const run = new Run("r", "t", "c", "h", 100);
    run.appendText("i1", "a");
    run.appendText("i1", "b");
    const sub = collect(run, 1);
    run.appendText("i1", "c");
    assert.deepEqual(
      sub.events.map((e) => e.seq),
      [2, 3],
    );
  });

  test("sends a snapshot when the cursor is older than the buffer", () => {
    const run = new Run("r", "t", "c", "h", 3);
    for (const ch of "abcdef") run.appendText("i1", ch);
    const sub = collect(run, 0);
    assert.equal(sub.events[0]!.type, "run.snapshot");
    assert.deepEqual(sub.events[0]!.data.items, [
      { itemId: "i1", text: "abcdef", completed: false },
    ]);
    run.appendText("i1", "g");
    assert.equal(sub.events.at(-1)!.seq, 7);
  });

  test("a finished run ends subscribers on run.completed, and ignores later events", () => {
    const run = new Run("r", "t", "c", "h", 2);
    for (const ch of "abcd") run.appendText("i1", ch);
    run.finish("stopped", null, null);
    run.appendText("i1", "late");
    const sub = collect(run, 0);
    assert.deepEqual(
      sub.events.map((e) => e.type),
      ["run.snapshot", "run.completed"],
    );
    assert.equal(sub.ended(), true);
    const items = sub.events[1]!.data.items as Array<{ text: string }>;
    assert.equal(items[0]!.text, "abcd");
  });

  test("a completed item replaces streamed text and later deltas are ignored", () => {
    const run = new Run("r", "t", "c", "h", 10);
    run.appendText("i1", "draft");
    run.completeItem("i1", "final");
    run.appendText("i1", "late");
    run.completeItem("i1", "again");
    assert.deepEqual(run.itemList(), [
      { itemId: "i1", text: "final", completed: true },
    ]);
  });
});

describe("Codex error mapping", () => {
  test("uses the typed error info, never the message", () => {
    assert.equal(
      fromCodexErrorInfo("contextWindowExceeded").code,
      "CONTEXT_FULL",
    );
    assert.equal(fromCodexErrorInfo("rateLimitExceeded").code, "RATE_LIMITED");
    assert.equal(fromCodexErrorInfo("usageLimitExceeded").code, "RATE_LIMITED");
    assert.equal(
      fromCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 502 } })
        .code,
      "PROVIDER_ERROR",
    );
    assert.equal(fromCodexErrorInfo(null).code, "PROVIDER_ERROR");
    assert.equal(fromCodexErrorInfo("somethingNew").code, "PROVIDER_ERROR");
  });
});
