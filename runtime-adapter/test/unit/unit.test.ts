import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConfigError, DEFAULT_LIMITS, loadConfig } from "../../src/config";
import {
  MAX_TEXT,
  parseApproval,
  parseChatRef,
  parseStartRun,
  parseSteer,
} from "../../src/contract";
import { AdapterError, fromCodexErrorInfo } from "../../src/errors";
import { Run, type RunEvent } from "../../src/runtime/run";
import {
  addTurnUsage,
  parsePlan,
  PLAN_EXPLANATION_CHARS,
  PLAN_MAX_STEPS,
  PLAN_STEP_CHARS,
} from "../../src/runtime/chat";
import {
  PLANNING_INSTRUCTIONS,
  threadResumeParams,
  threadStartParams,
} from "../../src/codex/config";
import { detectToolchains } from "../../src/codex/coding";
import {
  commandScope,
  displayCommand,
  hasHiddenCharacters,
  isPush,
  MAX_COMMAND_OUTPUT,
  MAX_DIFF_CHARS,
  OUTPUT_TAIL_LIMIT,
  parseChanges,
  PathMask,
  splitStreamed,
  workspacePath,
} from "../../src/codex/activity";

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
      approvalMs: DEFAULT_LIMITS.approvalMs,
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
    // Emoji sequences, joiners in many scripts and direction marks are text.
    for (const text of [
      "👨‍💻 done",
      "می‌خواهم",
      "שלום\u200F!",
      "🏴\u{E0067}\u{E007F}",
    ])
      assert.equal(
        parseStartRun(
          { ...valid(), input: { text, clientMessageId: "m" } },
          DEFAULT_LIMITS,
        ).input.text,
        text,
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
      approvalMs: DEFAULT_LIMITS.approvalMs,
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

describe("start-run network contract", () => {
  const github = () => ({
    name: "github",
    displayName: "GitHub",
    account: "octocat",
    access: "read_write",
    hosts: ["github.com", "api.github.com"],
    reads: [{ methods: ["GET", "HEAD"] }],
    critical: [{ methods: ["DELETE"], hosts: ["api.github.com"] }],
    credential: {
      auth: ["bearer", "basic"],
      urlPrefixes: ["https://api.github.com/", "https://github.com/"],
      tokenPattern: "gh[pousr]_[A-Za-z0-9]{36}",
      token: "ghp_" + "a".repeat(36),
    },
  });
  const withNetwork = (network: unknown) => ({ ...valid(), network });

  test("absent stays absent; a full policy round-trips", () => {
    assert.equal("network" in parseStartRun(valid(), DEFAULT_LIMITS), false);
    const policy = {
      hosts: ["pypi.org", "registry.npmjs.org"],
      connectors: [github()],
    };
    assert.deepEqual(
      parseStartRun(withNetwork(policy), DEFAULT_LIMITS).network,
      policy,
    );
  });

  test("hosts must be public DNS names, never IP literals or local zones", () => {
    for (const host of [
      "169.254.169.254",
      "127.0.0.1",
      "[::1]",
      "localhost",
      "db.internal",
      "*.github.com",
      "GitHub.com",
      "metadata.google.internal",
      "x.test",
      "single",
    ])
      rejects(
        withNetwork({ hosts: [host], connectors: [] }),
        /network\.hosts\[0\]/,
      );
  });

  test("a connector's rules and token stay on its own hosts", () => {
    rejects(
      withNetwork({ hosts: ["github.com"], connectors: [github()] }),
      /must not repeat network\.hosts/,
    );
    rejects(
      withNetwork({
        hosts: [],
        connectors: [
          {
            ...github(),
            reads: [{ methods: ["GET"], hosts: ["evil.example.com"] }],
          },
        ],
      }),
      /reads\[0\]\.hosts/,
    );
    for (const prefix of [
      "https://evil.example.com/",
      "http://api.github.com/",
      "https://api.github.com",
      "https://api.github.com:8443/",
      "https://u:p@api.github.com/",
    ])
      rejects(
        withNetwork({
          hosts: [],
          connectors: [
            {
              ...github(),
              credential: { ...github().credential, urlPrefixes: [prefix] },
            },
          ],
        }),
        /urlPrefixes\[0\]/,
      );
    rejects(
      withNetwork({ hosts: [], connectors: [github(), github()] }),
      /names must be unique/,
    );
    rejects(
      withNetwork({ hosts: [], connectors: [{ ...github(), extra: true }] }),
      /extra/,
    );
  });

  test("a rejected token is never echoed", () => {
    try {
      parseStartRun(
        withNetwork({
          hosts: [],
          connectors: [
            {
              ...github(),
              credential: { ...github().credential, token: "SECRET TOKEN" },
            },
          ],
        }),
        DEFAULT_LIMITS,
      );
      assert.fail("expected rejection");
    } catch (error) {
      assert.match((error as Error).message, /token is invalid/);
      assert.doesNotMatch((error as Error).message, /SECRET/);
    }
  });
});

describe("start-run MCP contract", () => {
  const server = () => ({
    name: "github",
    url: "https://api.example.com/mcp",
    headers: { Authorization: "Bearer tok", "X-MCP-Toolsets": "issues" },
    toolTimeoutSec: 60,
    startupTimeoutSec: 15,
  });
  const withMcp = (mcp: unknown) => ({ ...valid(), mcp });

  function parse(body: unknown, allowLoopbackMcp = false) {
    return parseStartRun(body, DEFAULT_LIMITS, { allowLoopbackMcp });
  }
  function rejectsMcp(mcp: unknown, pattern: RegExp, allowLoopback = false) {
    assert.throws(
      () => parse(withMcp(mcp), allowLoopback),
      (error: unknown) =>
        error instanceof AdapterError &&
        error.code === "INVALID_REQUEST" &&
        pattern.test(error.message),
    );
  }

  test("absent or empty mcp is accepted and omitted", () => {
    assert.equal(parse(valid()).mcp, undefined);
    const empty = parse(withMcp([]));
    assert.deepEqual(empty.mcp, []);
  });

  test("accepts a well-formed server list", () => {
    const parsed = parse(withMcp([server()]));
    assert.deepEqual(parsed.mcp, [server()]);
  });

  test("there is no approval field anywhere", () => {
    rejectsMcp(
      [{ ...server(), default_tools_approval_mode: "approve" }],
      /Unknown field/,
    );
    rejectsMcp([{ ...server(), approvalMode: "approve" }], /Unknown field/);
    rejectsMcp([{ ...server(), approval_mode: "approve" }], /Unknown field/);
  });

  test("criticalTools: optional, validated, and removed from approvedTools", () => {
    const parsed = parse(
      withMcp([
        {
          ...server(),
          approvedTools: ["create_branch", "delete_repo"],
          criticalTools: ["delete_repo"],
        },
      ]),
    );
    assert.deepEqual(parsed.mcp?.[0]?.approvedTools, ["create_branch"]);
    assert.deepEqual(parsed.mcp?.[0]?.criticalTools, ["delete_repo"]);
    rejectsMcp(
      [{ ...server(), criticalTools: ["bad name"] }],
      /criticalTools has an invalid tool name/,
    );
  });

  test("an MCP URL may not name an address or a local or metadata host", () => {
    for (const url of [
      "https://127.0.0.1/mcp",
      "https://10.0.0.5/mcp",
      "https://169.254.169.254/latest",
      "https://[::1]/mcp",
      "https://0x7f000001/mcp",
      "https://localhost/mcp",
      "https://mcp.localhost/mcp",
      "https://sap.local/mcp",
      "https://metadata.google.internal/x",
    ])
      rejectsMcp([{ ...server(), url }], /private or local address|https URL/);
    assert.ok(
      parse(withMcp([{ ...server(), url: "https://api.example.com/mcp" }])),
    );
  });

  test("approvedTools: optional, validated like enabledTools, empty omitted", () => {
    const parsed = parse(
      withMcp([{ ...server(), approvedTools: ["create_branch"] }]),
    );
    assert.deepEqual(parsed.mcp?.[0]?.approvedTools, ["create_branch"]);
    assert.equal(
      parse(withMcp([{ ...server(), approvedTools: [] }])).mcp?.[0]
        ?.approvedTools,
      undefined,
    );
    rejectsMcp(
      [{ ...server(), approvedTools: ["bad name"] }],
      /approvedTools has an invalid tool name/,
    );
    rejectsMcp([{ ...server(), approvedTools: "x" }], /approvedTools must be/);
  });

  test("approvalMs defaults to the adapter's limit and may only be shortened", () => {
    assert.equal(parse(valid()).limits.approvalMs, DEFAULT_LIMITS.approvalMs);
    assert.equal(
      parse({ ...valid(), limits: { approvalMs: 30_000 } }).limits.approvalMs,
      30_000,
    );
    rejects(
      { ...valid(), limits: { approvalMs: DEFAULT_LIMITS.approvalMs + 1 } },
      /limits.approvalMs/,
    );
    rejects({ ...valid(), limits: { approvalMs: 9_999 } }, /limits.approvalMs/);
  });

  test("at most three servers, with unique names", () => {
    const four = [1, 2, 3, 4].map((i) => ({ ...server(), name: `s${i}` }));
    rejectsMcp(four, /at most 3/);
    rejectsMcp([server(), server()], /unique/);
    rejectsMcp("notarray", /mcp must be an array/);
  });

  test("names must match the slug pattern", () => {
    for (const name of ["", "A", "1github", "git-hub", "x".repeat(32), "gi!"])
      rejectsMcp([{ ...server(), name }], /name is invalid/);
    assert.ok(parse(withMcp([{ ...server(), name: "gh_1" }])).mcp);
  });

  test("https only; http refused unless loopback and the flag is set", () => {
    rejectsMcp([{ ...server(), url: "http://api.example.com/mcp" }], /https/);
    rejectsMcp([{ ...server(), url: "ftp://x/mcp" }], /https/);
    rejectsMcp([{ ...server(), url: "https://u:p@x/mcp" }], /credentials/);
    rejectsMcp([{ ...server(), url: "https://x/mcp?a=1" }], /credentials/);
    rejectsMcp([{ ...server(), url: "https://x/mcp#f" }], /credentials/);
    // http loopback is refused when the flag is off, accepted when on.
    rejectsMcp(
      [{ ...server(), url: "http://127.0.0.1:9/mcp" }],
      /https/,
      false,
    );
    rejectsMcp([{ ...server(), url: "http://example.com/mcp" }], /https/, true); // non-loopback http still refused with the flag
    assert.ok(
      parse(withMcp([{ ...server(), url: "http://127.0.0.1:9000/mcp" }]), true)
        .mcp,
    );
    assert.ok(
      parse(withMcp([{ ...server(), url: "http://localhost:9000/mcp" }]), true)
        .mcp,
    );
  });

  test("headers: at most 16, valid names, 1-8192 chars, no CR/LF/NUL", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 17; i++) many[`H${i}`] = "v";
    rejectsMcp([{ ...server(), headers: many }], /at most 16/);
    rejectsMcp(
      [{ ...server(), headers: { "Bad Header": "v" } }],
      /header name/,
    );
    rejectsMcp([{ ...server(), headers: { "X-H": "" } }], /value for header/);
    rejectsMcp(
      [{ ...server(), headers: { "X-H": "x".repeat(8193) } }],
      /value for header/,
    );
    rejectsMcp(
      [{ ...server(), headers: { "X-H": "a\nb" } }],
      /value for header/,
    );
    rejectsMcp(
      [{ ...server(), headers: { "X-H": "a\u0000b" } }],
      /value for header/,
    );
    rejectsMcp([{ ...server(), headers: "notobject" }], /JSON object/);
  });

  test("the rejected header VALUE is never echoed, only the name", () => {
    try {
      parse(withMcp([{ ...server(), headers: { "X-H": "SECRET_VALUE\n" } }]));
      assert.fail("expected rejection");
    } catch (error) {
      const message = String((error as Error).message);
      assert.ok(!message.includes("SECRET_VALUE"));
      assert.ok(message.includes("X-H"));
    }
  });

  test("enabledTools: optional, at most 200, valid names", () => {
    assert.ok(parse(withMcp([{ ...server(), enabledTools: ["a.b-c_1"] }])).mcp);
    const many = Array.from({ length: 201 }, (_, i) => `t${i}`);
    rejectsMcp([{ ...server(), enabledTools: many }], /at most 200/);
    rejectsMcp([{ ...server(), enabledTools: ["bad tool"] }], /tool name/);
    rejectsMcp([{ ...server(), enabledTools: "nope" }], /array of tool names/);
  });

  test("timeouts are bounded", () => {
    rejectsMcp([{ ...server(), toolTimeoutSec: 0 }], /toolTimeoutSec/);
    rejectsMcp([{ ...server(), toolTimeoutSec: 301 }], /toolTimeoutSec/);
    rejectsMcp([{ ...server(), startupTimeoutSec: 0 }], /startupTimeoutSec/);
    rejectsMcp([{ ...server(), startupTimeoutSec: 61 }], /startupTimeoutSec/);
  });

  test("unknown fields on a server are refused", () => {
    rejectsMcp([{ ...server(), extra: 1 }], /Unknown field/);
  });
});

describe("approval answer contract", () => {
  test("accepts the three answers and nothing else", () => {
    for (const decision of ["allow", "allow_for_chat", "deny"])
      assert.deepEqual(
        parseApproval({ tenantId: "t1", chatId: "c1", decision }),
        { tenantId: "t1", chatId: "c1", decision },
      );
    // expired/cancelled are outcomes, never answers; "always" is not offered.
    for (const decision of ["expired", "cancelled", "always", "", null])
      assert.throws(
        () => parseApproval({ tenantId: "t1", chatId: "c1", decision }),
        (e: unknown) => e instanceof AdapterError && /decision/.test(e.message),
      );
    assert.throws(
      () =>
        parseApproval({
          tenantId: "t1",
          chatId: "c1",
          decision: "allow",
          persist: "always",
        }),
      /Unknown field/,
    );
  });
});

describe("steer contract", () => {
  const valid = () => ({
    tenantId: "t",
    chatId: "c",
    input: { text: "steer me", clientMessageId: "m2" },
  });

  test("accepts a valid steer, validated like start input", () => {
    assert.deepEqual(parseSteer(valid()), {
      tenantId: "t",
      chatId: "c",
      input: { text: "steer me", clientMessageId: "m2" },
    });
  });

  function rejects(body: unknown, pattern: RegExp) {
    assert.throws(
      () => parseSteer(body),
      (error: unknown) =>
        error instanceof AdapterError &&
        error.code === "INVALID_REQUEST" &&
        pattern.test(error.message),
    );
  }

  test("refuses unknown fields, bad IDs and bad text", () => {
    rejects({ ...valid(), runId: "x" }, /Unknown field "runId"/);
    rejects({ ...valid(), input: { ...valid().input, extra: 1 } }, /Unknown/);
    rejects({ ...valid(), chatId: "../x" }, /chatId/);
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
      { ...valid(), input: { text: "a\u0000b", clientMessageId: "m" } },
      /control/,
    );
    rejects(
      { ...valid(), input: { text: "ok", clientMessageId: "a b" } },
      /clientMessageId/,
    );
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

  // Regression: Node's bin directory came first, so a Homebrew Node
  // (/opt/homebrew/bin, which also holds Homebrew's python3) shadowed the
  // toolchain Python that has the pinned document libraries.
  test("listed toolchains come before Node's own bin directory on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-adapter-toolchain-"));
    try {
      await mkdir(join(root, "node", "bin"), { recursive: true });
      await mkdir(join(root, "python", "bin"), { recursive: true });
      const { path, readRoots } = detectToolchains(
        [join(root, "python"), join(root, "missing")],
        "linux",
        join(root, "node", "bin", "node"),
      );
      const entries = path.split(":");
      assert.deepEqual(entries.slice(0, 2), [
        join(root, "python", "bin"),
        join(root, "node", "bin"),
      ]);
      assert.ok(!path.includes("missing"));
      assert.deepEqual(readRoots, [join(root, "node"), join(root, "python")]);
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
      { type: "reply", itemId: "i1", text: "abcdef", completed: false },
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
      { type: "reply", itemId: "i1", text: "final", completed: true },
    ]);
  });

  test("items are ordered reply/input, the run's own input is excluded, and empty replies never appear", () => {
    const run = new Run("r", "t", "c", "h", 100, "own-input");
    // The run's own input is ignored.
    run.recordInput("own-input");
    // A reply, then a steer that cuts it, then the follow-up reply.
    run.appendText("i1", "first ");
    run.recordInput("steer-1");
    run.appendText("i2", "second");
    // An empty reply (started, cut before any text) is never placed.
    run.completeItem("i3", "");
    assert.deepEqual(run.itemList(), [
      { type: "reply", itemId: "i1", text: "first ", completed: false },
      { type: "input", clientMessageId: "steer-1" },
      { type: "reply", itemId: "i2", text: "second", completed: false },
    ]);
  });

  test("recordInput emits input.accepted once per steer, in order", () => {
    const run = new Run("r", "t", "c", "h", 100, "own-input");
    const sub = collect(run, 0);
    run.recordInput("own-input"); // the run's own input: no event
    run.recordInput("steer-1");
    run.recordInput("steer-1"); // repeat: no second event
    run.recordInput("steer-2");
    assert.deepEqual(
      sub.events
        .filter((e) => e.type === "input.accepted")
        .map((e) => e.data.clientMessageId),
      ["steer-1", "steer-2"],
    );
  });

  test("a tool call is placed in stream order and shows inProgress until it completes", () => {
    const run = new Run("r", "t", "c", "h", 100);
    run.appendText("i1", "before ");
    run.startTool("t1", "github", "get_issue");
    // Snapshot while the call is in flight: status is inProgress, no duration.
    assert.deepEqual(run.itemList(), [
      { type: "reply", itemId: "i1", text: "before ", completed: false },
      {
        type: "tool",
        itemId: "t1",
        connector: "github",
        tool: "get_issue",
        status: "inProgress",
      },
    ]);
    assert.equal(run.inFlightToolCount, 1);
    run.completeTool("t1", "github", "get_issue", "completed", 42);
    assert.equal(run.inFlightToolCount, 0);
    assert.deepEqual(run.itemList()[1], {
      type: "tool",
      itemId: "t1",
      connector: "github",
      tool: "get_issue",
      status: "completed",
      durationMs: 42,
    });
  });

  test("a failed tool call carries its errorCode and emits tool events", () => {
    const run = new Run("r", "t", "c", "h", 100);
    const sub = collect(run, 0);
    run.startTool("t1", "github", "create_issue");
    run.completeTool("t1", "github", "create_issue", "failed", 7, "REFUSED");
    assert.deepEqual(
      sub.events.map((e) => e.type),
      ["tool.started", "tool.completed"],
    );
    assert.deepEqual(sub.events[1]!.data, {
      itemId: "t1",
      connector: "github",
      tool: "create_issue",
      status: "failed",
      durationMs: 7,
      errorCode: "REFUSED",
    });
    assert.deepEqual(run.itemList(), [
      {
        type: "tool",
        itemId: "t1",
        connector: "github",
        tool: "create_issue",
        status: "failed",
        durationMs: 7,
        errorCode: "REFUSED",
      },
    ]);
  });

  test("a completion without a start is still recorded; a double completion is ignored", () => {
    const run = new Run("r", "t", "c", "h", 100);
    run.completeTool("t1", "github", "get_issue", "completed", 5);
    run.completeTool("t1", "github", "get_issue", "failed", 9, "TOOL_ERROR");
    assert.deepEqual(run.itemList(), [
      {
        type: "tool",
        itemId: "t1",
        connector: "github",
        tool: "get_issue",
        status: "completed",
        durationMs: 5,
      },
    ]);
  });

  test("approvals: pending ones are in the snapshot; the decision lands on the tool item", () => {
    const run = new Run("r", "t", "c", "h", 1, "m0");
    run.startTool("i1", "github", "create_branch");
    const approval = {
      approvalId: "ap_1",
      itemId: "i1",
      kind: "mcp" as const,
      connector: "github",
      tool: "create_branch",
      params: [{ name: "branch", value: "feature/x" }],
      allowForChat: true,
      expiresAt: 123,
    };
    run.requestApproval(approval);
    assert.deepEqual(run.pendingApprovals, [approval]);
    // The buffer (1) has rolled past the cursor, so a snapshot is sent.
    const { events } = collect(run, 0);
    const snapshot = events.find((e) => e.type === "run.snapshot")!;
    assert.deepEqual(snapshot.data.approvals, [approval]);

    run.resolveApproval(approval, "deny", false);
    assert.deepEqual(run.pendingApprovals, []);
    const resolved = events.at(-1)!;
    assert.equal(resolved.type, "approval.resolved");
    assert.deepEqual(resolved.data, {
      approvalId: "ap_1",
      itemId: "i1",
      kind: "mcp",
      connector: "github",
      tool: "create_branch",
      params: [{ name: "branch", value: "feature/x" }],
      decision: "deny",
      auto: false,
    });
    run.completeTool("i1", "github", "create_branch", "failed", 5, "DENIED");
    assert.deepEqual(run.itemList(), [
      {
        type: "tool",
        itemId: "i1",
        connector: "github",
        tool: "create_branch",
        status: "failed",
        durationMs: 5,
        errorCode: "DENIED",
        approval: "deny",
      },
    ]);
  });

  test("connectorStatus emits connector.status and is not an ordered item", () => {
    const run = new Run("r", "t", "c", "h", 100);
    const sub = collect(run, 0);
    run.connectorStatus("github", "failed", "auth");
    assert.deepEqual(
      sub.events.map((e) => [e.type, e.data]),
      [
        [
          "connector.status",
          { connector: "github", status: "failed", reason: "auth" },
        ],
      ],
    );
    assert.deepEqual(run.itemList(), []);
  });
});

describe("plan checklist", () => {
  const steps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      step: `Step ${i + 1}`,
      status: "pending",
    }));

  test("parsePlan keeps well-formed steps and a trimmed explanation", () => {
    assert.deepEqual(
      parsePlan({
        explanation: "  Two parts. ",
        plan: [
          { step: "Research", status: "inProgress" },
          { step: "Write", status: "pending" },
          { step: "Check", status: "completed" },
        ],
      }),
      {
        explanation: "Two parts.",
        steps: [
          { step: "Research", status: "inProgress" },
          { step: "Write", status: "pending" },
          { step: "Check", status: "completed" },
        ],
      },
    );
  });

  test("parsePlan drops malformed steps and never throws", () => {
    assert.deepEqual(
      parsePlan({
        explanation: 42,
        plan: [
          null,
          "Research",
          { step: "", status: "pending" },
          { step: "   ", status: "pending" },
          { step: "Snake case", status: "in_progress" },
          { step: 7, status: "pending" },
          { step: "Kept", status: "completed", extra: true },
        ],
      }),
      { explanation: null, steps: [{ step: "Kept", status: "completed" }] },
    );
    assert.deepEqual(parsePlan({}), { explanation: null, steps: [] });
    assert.deepEqual(parsePlan({ plan: "nope", explanation: "  " }), {
      explanation: null,
      steps: [],
    });
  });

  test("parsePlan truncates oversized input instead of rejecting it", () => {
    const plan = parsePlan({
      explanation: "e".repeat(PLAN_EXPLANATION_CHARS + 100),
      plan: [
        { step: "s".repeat(PLAN_STEP_CHARS + 100), status: "pending" },
        ...steps(PLAN_MAX_STEPS + 10),
      ],
    });
    assert.equal(plan.steps.length, PLAN_MAX_STEPS);
    assert.equal(plan.steps[0]!.step.length, PLAN_STEP_CHARS);
    assert.ok(plan.steps[0]!.step.endsWith("…"));
    assert.equal(plan.explanation!.length, PLAN_EXPLANATION_CHARS);
    // Control and bidi characters never reach the member.
    assert.equal(
      parsePlan({ plan: [{ step: "a‮b\u0007c", status: "pending" }] }).steps[0]!
        .step,
      "abc",
    );
  });

  // Regression: a cut at the cap split an emoji, leaving half of a surrogate
  // pair (an invalid string) in the step and the explanation.
  test("parsePlan never cuts an emoji in half at the cap", () => {
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // An emoji is two UTF-16 units; one extra leading unit puts a pair
    // across the cut for one of the two parities.
    for (const lead of ["", "a"]) {
      const plan = parsePlan({
        explanation: lead + "😀".repeat(PLAN_EXPLANATION_CHARS),
        plan: [
          { step: lead + "😀".repeat(PLAN_STEP_CHARS), status: "pending" },
        ],
      });
      const step = plan.steps[0]!.step;
      assert.ok(
        !loneSurrogate.test(step),
        `step, lead=${JSON.stringify(lead)}`,
      );
      assert.ok(step.endsWith("😀…"));
      assert.ok(step.length <= PLAN_STEP_CHARS);
      assert.ok(!loneSurrogate.test(plan.explanation!), "explanation");
      assert.ok(plan.explanation!.endsWith("😀…"));
      assert.ok(plan.explanation!.length <= PLAN_EXPLANATION_CHARS);
    }
  });

  test("parsePlan strips every C0, DEL/C1 and bidi override or isolate character, and only those", () => {
    const text = (s: string) =>
      parsePlan({ plan: [{ step: `a${s}b`, status: "pending" }] }).steps[0]!
        .step;
    // Each stripped range at both ends.
    for (const ch of [
      "\u0000",
      "\u0008",
      "\u000B",
      "\u001F",
      "\u007F",
      "\u009F",
      "\u202A",
      "\u202E",
      "\u2066",
      "\u2069",
    ])
      assert.equal(text(ch), "ab", `U+${ch.codePointAt(0)!.toString(16)}`);
    // Their neighbours are kept: tab, newline, space, no-break space and
    // the characters just outside the bidi ranges.
    for (const ch of ["\t", "\n", " ", "\u00A0", "\u202F", "\u2065", "\u206A"])
      assert.equal(text(ch), `a${ch}b`, `U+${ch.codePointAt(0)!.toString(16)}`);
  });

  test("the latest plan replaces the last, in the snapshot and the outcome", () => {
    const run = new Run("r", "t", "c", "h", 100);
    const events: RunEvent[] = [];
    run.subscribe(0, { send: (e) => events.push(e), end: () => undefined });
    const first = {
      explanation: null,
      steps: [{ step: "A", status: "inProgress" as const }],
    };
    const second = {
      explanation: "Changed.",
      steps: [
        { step: "A", status: "completed" as const },
        { step: "B", status: "inProgress" as const },
      ],
    };
    run.updatePlan(first);
    run.updatePlan(second);
    assert.deepEqual(
      events.filter((e) => e.type === "plan.updated").map((e) => e.data),
      [first, second],
    );

    // A late subscriber whose cursor fell out of the buffer gets a snapshot.
    const small = new Run("r", "t", "c", "h", 1);
    small.updatePlan(first);
    small.updatePlan(second);
    const snapshot: RunEvent[] = [];
    small.subscribe(0, { send: (e) => snapshot.push(e), end: () => undefined });
    assert.equal(snapshot[0]!.type, "run.snapshot");
    assert.deepEqual(snapshot[0]!.data.plan, second);

    run.finish("completed", null, null);
    run.updatePlan(first);
    const done = events.filter((e) => e.type === "run.completed");
    assert.equal(done.length, 1);
    assert.deepEqual(done[0]!.data.plan, second);
    assert.equal(events.at(-1)!.type, "run.completed", "nothing after finish");

    // A plan after finish never changes what a late reader is shown.
    small.finish("stopped", null, null);
    small.updatePlan(first);
    const late: RunEvent[] = [];
    small.subscribe(0, { send: (e) => late.push(e), end: () => undefined });
    assert.deepEqual(
      late.map((e) => [e.type, e.data.plan]),
      [
        ["run.snapshot", second],
        ["run.completed", second],
      ],
    );
  });

  test("an empty plan is passed through; a run that never planned has no plan field", () => {
    const run = new Run("r", "t", "c", "h", 100);
    const events: RunEvent[] = [];
    run.subscribe(0, { send: (e) => events.push(e), end: () => undefined });
    run.updatePlan({ explanation: null, steps: [] });
    run.finish("completed", null, null);
    assert.deepEqual(events.at(-1)!.data.plan, {
      explanation: null,
      steps: [],
    });

    const plain = new Run("r", "t", "c", "h", 100);
    const plainEvents: RunEvent[] = [];
    plain.subscribe(0, {
      send: (e) => plainEvents.push(e),
      end: () => undefined,
    });
    plain.finish("completed", null, null);
    assert.ok(!("plan" in plainEvents.at(-1)!.data));
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
    // A provider 429 after retries (seen on the nvidia profile).
    assert.equal(
      fromCodexErrorInfo({
        responseTooManyFailedAttempts: { httpStatusCode: 429 },
      }).code,
      "RATE_LIMITED",
    );
    assert.equal(
      fromCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 429 } })
        .code,
      "RATE_LIMITED",
    );
    assert.equal(
      fromCodexErrorInfo({
        responseTooManyFailedAttempts: { httpStatusCode: 503 },
      }).code,
      "PROVIDER_ERROR",
    );
    assert.equal(fromCodexErrorInfo(null).code, "PROVIDER_ERROR");
    assert.equal(fromCodexErrorInfo("somethingNew").code, "PROVIDER_ERROR");
  });
});

describe("codex MCP config", () => {
  const model = {
    modelName: "fixture-model",
    gatewayUrl: "https://g/v1",
    gatewayToken: "token-0123456789abcdef",
    contextWindow: 100_000,
    autoCompactTokenLimit: 80_000,
  };
  const spec = {
    name: "github",
    url: "https://api.example.com/mcp",
    headers: { Authorization: "Bearer tok" },
    enabledTools: ["get_issue"],
    toolTimeoutSec: 60,
    startupTimeoutSec: 15,
  };

  test("approval policy: never when text-only, MCP prompts only with connectors", () => {
    assert.equal(
      threadStartParams(model, "prompt", "/ws").approvalPolicy,
      "never",
    );
    for (const params of [
      threadStartParams(model, "prompt", "/ws", [spec]),
      threadResumeParams("tid", model, "/ws", [spec]),
    ])
      assert.deepEqual(params.approvalPolicy, {
        granular: {
          sandbox_approval: false,
          rules: false,
          skill_approval: false,
          request_permissions: false,
          mcp_elicitations: true,
        },
      });
  });

  test("approvedTools never reaches Codex config", () => {
    const start = threadStartParams(model, "prompt", "/ws", [
      { ...spec, approvedTools: ["create_branch"] },
    ]);
    assert.ok(!JSON.stringify(start).includes("create_branch"));
  });

  // Threads created before the planning guidance existed get it on their
  // next resume; Codex keeps a thread's earlier copy, so only the params show
  // that it is resent.
  test("start and resume both carry the planning guidance, text and coding", () => {
    const coding = { config: {}, instructions: "CODING_RULES" };
    for (const params of [
      threadStartParams(model, "prompt", "/ws"),
      threadResumeParams("tid", model, "/ws"),
      threadStartParams(model, "prompt", "/ws", [], coding),
      threadResumeParams("tid", model, "/ws", [], coding),
    ])
      assert.ok(params.developerInstructions.includes(PLANNING_INSTRUCTIONS));
  });

  test("text-only params carry no mcp_servers keys", () => {
    const start = threadStartParams(model, "prompt", "/ws");
    const resume = threadResumeParams("tid", model, "/ws");
    assert.ok(
      !Object.keys(start.config).some((k) => k.startsWith("mcp_servers.")),
    );
    assert.ok(
      !Object.keys(resume.config).some((k) => k.startsWith("mcp_servers.")),
    );
    // An empty list is identical to omitting it.
    assert.deepEqual(threadStartParams(model, "prompt", "/ws", []), start);
  });

  test("an mcp server becomes mcp_servers.<name> with forced auto approval", () => {
    const start = threadStartParams(model, "prompt", "/ws", [spec]);
    const entry = (start.config as Record<string, unknown>)[
      "mcp_servers.github"
    ] as Record<string, unknown>;
    assert.deepEqual(entry, {
      url: "https://api.example.com/mcp",
      http_headers: { Authorization: "Bearer tok" },
      enabled_tools: ["get_issue"],
      tool_timeout_sec: 60,
      startup_timeout_sec: 15,
      default_tools_approval_mode: "auto",
    });
  });

  test("the same config is sent on resume (probe 3: resume without it drops tools)", () => {
    const resume = threadResumeParams("tid", model, "/ws", [spec]);
    const entry = (resume.config as Record<string, unknown>)[
      "mcp_servers.github"
    ] as Record<string, unknown>;
    assert.equal(entry.default_tools_approval_mode, "auto");
    assert.equal(entry.url, "https://api.example.com/mcp");
  });

  test("never emits an approve mode or a per-tool approval_mode", () => {
    const start = threadStartParams(model, "prompt", "/ws", [spec]);
    const serialized = JSON.stringify(start);
    assert.ok(!/"approve"/.test(serialized), "no approve mode anywhere");
    assert.ok(!/approval_mode":\s*"approve"/.test(serialized));
    const entry = (start.config as Record<string, unknown>)[
      "mcp_servers.github"
    ] as Record<string, unknown>;
    assert.equal(entry.tools, undefined, "no per-tool overrides");
  });

  test("enabled_tools is omitted when not given", () => {
    const start = threadStartParams(model, "prompt", "/ws", [
      {
        name: "github",
        url: "https://api.example.com/mcp",
        headers: {},
        toolTimeoutSec: 60,
        startupTimeoutSec: 15,
      },
    ]);
    const entry = (start.config as Record<string, unknown>)[
      "mcp_servers.github"
    ] as Record<string, unknown>;
    assert.equal(entry.enabled_tools, undefined);
  });
});

describe("coding activity display", () => {
  const ws = "/state/t/a/c/b/workspace";

  test("the shell wrapper is removed only when the inner text is exactly what runs", () => {
    assert.equal(displayCommand("/bin/zsh -lc 'touch a.txt'"), "touch a.txt");
    assert.equal(displayCommand("bash -lc 'ls'"), "ls");
    // Double quotes with nothing special inside are removed too.
    assert.equal(
      displayCommand(`/bin/zsh -lc "sed -i '' s/a/b/ f"`),
      "sed -i '' s/a/b/ f",
    );
    // $, backticks and backslashes expand inside double quotes: kept whole.
    for (const raw of [
      `/bin/zsh -lc "echo '$HOME'"`,
      "/bin/zsh -lc \"echo '`id`'\"",
      `/bin/zsh -lc "echo 'a\\b'"`,
    ])
      assert.equal(displayCommand(raw), raw);
    assert.equal(displayCommand("node -v"), "node -v");
  });

  test("pushes are recognised inside chains and with options", () => {
    for (const cmd of [
      "git push",
      "git push origin main",
      "git -C repo push --force",
      "cd repo && git push",
    ])
      assert.equal(isPush(cmd), true, cmd);
    for (const cmd of ["git status", "echo push", "git pull"])
      assert.equal(isPush(cmd), false, cmd);
  });

  test("hidden characters are detected; tabs and newlines are allowed", () => {
    assert.equal(hasHiddenCharacters("ls\t-l\n"), false);
    assert.equal(hasHiddenCharacters("touch a\u202Etxt"), true);
    assert.equal(hasHiddenCharacters("echo \u001b[31m"), true);
  });

  test("paths are shown relative to the workspace, never absolute", () => {
    assert.equal(workspacePath(`${ws}/src/a.py`, ws), "src/a.py");
    assert.equal(workspacePath(ws, ws), ".");
    assert.equal(
      workspacePath("/state/t/a/c/b/home/x", ws),
      "(outside workspace)",
    );
  });

  test("changes are listed with kinds and the diff is bounded", () => {
    const parsed = parseChanges(
      [
        { path: `${ws}/a.txt`, kind: { type: "add" }, diff: "+x\n" },
        {
          path: `${ws}/b.txt`,
          kind: { type: "update", move_path: `${ws}/c.txt` },
          diff: "y".repeat(MAX_DIFF_CHARS),
        },
        { path: 7 },
      ],
      ws,
    );
    assert.deepEqual(parsed.files, [
      { path: "a.txt", kind: "add" },
      { path: "b.txt", kind: "move", movePath: "c.txt" },
    ]);
    assert.equal(parsed.diffTruncated, true);
    assert.equal(parsed.diff.length, MAX_DIFF_CHARS);
    assert.ok(!parsed.diff.includes("/state/"));
  });

  test("the scope is the exact command's hash", () => {
    assert.equal(commandScope("ls"), commandScope("ls"));
    assert.notEqual(commandScope("ls"), commandScope("ls "));
  });

  test("command output is capped on the item and in events", () => {
    const run = new Run("r", "t", "c", "h", 1000, "m0");
    run.startCommand("i1", "cat big");
    run.appendOutput("i1", "x".repeat(MAX_COMMAND_OUTPUT - 1));
    run.appendOutput("i1", "yz");
    run.appendOutput("i1", "more");
    run.completeCommand("i1", "cat big", "completed", 0, 5, "ignored");
    const item = run.itemList()[0]!;
    assert.equal(item.type, "command");
    if (item.type !== "command") return;
    assert.equal(item.output.length, MAX_COMMAND_OUTPUT);
    assert.equal(item.outputTruncated, true);
    assert.equal(item.exitCode, 0);
  });

  test("coding approval allows are validated", () => {
    const base = {
      runId: "r1",
      tenantId: "t",
      chatId: "c",
      threadId: null,
      input: { text: "hi", clientMessageId: "m1" },
      agentPrompt: "p",
      model: {
        modelName: "m",
        gatewayUrl: "http://127.0.0.1:1/v1",
        gatewayToken: "x".repeat(20),
        contextWindow: 10_000,
        autoCompactTokenLimit: 9_000,
      },
    };
    const ok = parseStartRun(
      {
        ...base,
        codingApprovals: { commands: ["a".repeat(64)] },
      },
      DEFAULT_LIMITS,
    );
    assert.deepEqual(ok.codingApprovals, { commands: ["a".repeat(64)] });
    for (const bad of [
      { commands: ["rm -rf /"] },
      { commands: [], fileChanges: true },
      { commands: [], extra: 1 },
    ])
      assert.throws(() =>
        parseStartRun({ ...base, codingApprovals: bad }, DEFAULT_LIMITS),
      );
  });
});

describe("turn usage", () => {
  const u = (input: number, output: number, cached = 0) => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
  });

  test("sums every call by the growth of the thread total", () => {
    // Thread already spent 100/10 in earlier turns.
    let sum = addTurnUsage(null, null, u(150, 15, 20), u(50, 5, 20));
    sum = addTurnUsage(sum, u(150, 15, 20), u(210, 22, 50), u(60, 7, 30));
    assert.equal(sum.inputTokens, 110);
    assert.equal(sum.cachedInputTokens, 50);
    assert.equal(sum.outputTokens, 12);
  });

  test("a repeated update with an unchanged total adds nothing", () => {
    let sum = addTurnUsage(null, null, u(150, 15), u(50, 5));
    // Compaction estimate / rate-limit refresh: same total, other `last`.
    sum = addTurnUsage(sum, u(150, 15), u(150, 15), u(0, 0));
    assert.equal(sum.inputTokens, 50);
    assert.equal(sum.outputTokens, 5);
  });

  test("a total that shrank (context full reset) adds nothing", () => {
    let sum = addTurnUsage(null, null, u(150, 15), u(50, 5));
    sum = addTurnUsage(sum, u(150, 15), { totalTokens: 1000 }, {});
    assert.equal(sum.inputTokens, 50);
    assert.equal(sum.totalTokens, 55);
  });

  test("bad values count as zero", () => {
    const sum = addTurnUsage(
      null,
      null,
      {},
      {
        inputTokens: -3,
        outputTokens: "9",
        cachedInputTokens: 1.5,
      },
    );
    assert.equal(sum.inputTokens, 0);
    assert.equal(sum.outputTokens, 0);
    assert.equal(sum.cachedInputTokens, 0);
  });
});

describe("path mask", () => {
  const state = "/mnt/state";
  const root = `${state}/t/6ad25557bd7f03d236240be6/c/6adb4715c1f7cc575261504b`;
  const sha = "e".repeat(64);
  const mask = new PathMask(
    {
      stateDir: state,
      chatRoot: root,
      workspace: `${root}/workspace`,
      scratch: `${root}/scratch`,
      skillLinks: `${root}/skills`,
    },
    ["/private/mnt/state"],
  );

  test("names each place by its variable, longest place first", () => {
    assert.equal(mask.apply(`${root}/workspace/out`), "$WORKSPACE/out");
    assert.equal(mask.apply(`cd ${root}/scratch`), "cd $TMPDIR");
    assert.equal(mask.apply(`${root}/skills/word`), "$SKILLS/word");
    assert.equal(mask.apply(`${root}/home/x`), "<chat>/home/x");
    assert.equal(
      mask.apply(`${state}/skills/${sha}/word/a.py`),
      "$SKILLS/word/a.py",
    );
    assert.equal(mask.apply(`${state}/other`), "<state>/other");
    assert.equal(
      mask.apply(`/private${root}/workspace`),
      "$WORKSPACE",
      "the real-path spelling",
    );
    assert.equal(mask.apply("relative/path $HOME"), "relative/path $HOME");
  });

  test("a place split across deltas is never shown in part", () => {
    const line = `saved ${root}/workspace/out.docx\n`;
    let tail = "";
    let shown = "";
    for (const piece of [
      line.slice(0, 20),
      line.slice(20, 50),
      line.slice(50),
    ]) {
      const r = splitStreamed(mask, tail + piece, false);
      shown += r.shown;
      tail = r.tail;
    }
    shown += splitStreamed(mask, tail, true).shown;
    assert.equal(shown, "saved $WORKSPACE/out.docx\n");
  });

  test("a long unbroken tail goes out without cutting a place", () => {
    const text = "x".repeat(OUTPUT_TAIL_LIMIT) + `${root}/workspace` + "y";
    const r = splitStreamed(mask, text, false);
    assert.ok(r.shown.length > 0);
    assert.ok(!r.shown.includes("/mnt") && !r.tail.startsWith("/workspace"));
    const all = r.shown + splitStreamed(mask, r.tail, true).shown;
    assert.equal(all, "x".repeat(OUTPUT_TAIL_LIMIT) + "$WORKSPACE" + "y");
  });
});

describe("sub-agents contract and config", () => {
  const model = {
    modelName: "fixture-model",
    gatewayUrl: "https://g/v1",
    gatewayToken: "token-0123456789abcdef",
    contextWindow: 100_000,
    autoCompactTokenLimit: 80_000,
  };

  test("subAgents is optional and absent by default", () => {
    assert.equal("subAgents" in parseStartRun(valid(), DEFAULT_LIMITS), false);
    assert.equal(
      "subAgents" in
        parseStartRun({ ...valid(), subAgents: null }, DEFAULT_LIMITS),
      false,
    );
    assert.deepEqual(
      parseStartRun(
        { ...valid(), subAgents: { maxConcurrent: 3 } },
        DEFAULT_LIMITS,
      ).subAgents,
      { maxConcurrent: 3 },
    );
  });

  test("subAgents rejects anything but 1-3 helpers", () => {
    for (const bad of [0, 4, 1.5, "2", -1, null])
      rejects(
        { ...valid(), subAgents: { maxConcurrent: bad } },
        /maxConcurrent/,
      );
    rejects({ ...valid(), subAgents: {} }, /maxConcurrent/);
    rejects({ ...valid(), subAgents: [] }, /subAgents must be a JSON object/);
    rejects(
      { ...valid(), subAgents: { maxConcurrent: 2, enabled: true } },
      /Unknown field "enabled"/,
    );
  });

  test("without subAgents the params are byte for byte unchanged", () => {
    assert.deepEqual(
      threadStartParams(model, "p", "/ws", [], undefined, [], undefined),
      threadStartParams(model, "p", "/ws"),
    );
    assert.deepEqual(
      threadResumeParams("tid", model, "/ws", [], undefined, undefined),
      threadResumeParams("tid", model, "/ws"),
    );
    assert.ok(
      !JSON.stringify(threadStartParams(model, "p", "/ws")).includes(
        "multi_agent_v2",
      ),
    );
    // The legacy engine stays off either way.
    assert.equal(
      threadStartParams(model, "p", "/ws").config["features.multi_agent"],
      false,
    );
  });

  test("subAgents turns on V2 with the lead counted and bounded waits", () => {
    for (const params of [
      threadStartParams(model, "p", "/ws", [], undefined, [], {
        maxConcurrent: 2,
      }),
      threadResumeParams("tid", model, "/ws", [], undefined, {
        maxConcurrent: 2,
      }),
    ]) {
      const v2 = (params.config as Record<string, unknown>)[
        "features.multi_agent_v2"
      ] as Record<string, unknown>;
      assert.equal(v2.enabled, true);
      assert.equal(v2.max_concurrent_threads_per_session, 3);
      assert.equal(v2.hide_spawn_agent_metadata, true);
      assert.ok((v2.max_wait_timeout_ms as number) < DEFAULT_LIMITS.silenceMs);
      assert.ok(
        (v2.min_wait_timeout_ms as number) <=
          (v2.default_wait_timeout_ms as number),
      );
      assert.ok(
        (v2.default_wait_timeout_ms as number) <=
          (v2.max_wait_timeout_ms as number),
      );
      assert.match(
        String(v2.subagent_developer_instructions),
        /Never change data/,
      );
      assert.match(String(v2.multi_agent_mode_hint_text), /fork_turns "none"/);
      // Nothing else of the text-only profile changes.
      assert.equal(params.config["features.shell_tool"], false);
      assert.equal(params.config["features.multi_agent"], false);
    }
  });

  test("a coding run gives helpers the shared-workspace rules, not read-only", () => {
    const coding = { config: {}, instructions: "coding instructions" };
    const v2 = (
      threadStartParams(model, "p", "/ws", [], coding, [], {
        maxConcurrent: 2,
      }).config as Record<string, unknown>
    )["features.multi_agent_v2"] as Record<string, unknown>;
    const rules = String(v2.subagent_developer_instructions);
    // Codex-exact Option B: helpers may write in the shared workspace, but
    // not make external connector changes.
    assert.match(rules, /share one workspace/);
    assert.match(rules, /write files/);
    assert.doesNotMatch(rules, /Never change data/);
    assert.match(String(v2.multi_agent_mode_hint_text), /share your workspace/);
  });
});
