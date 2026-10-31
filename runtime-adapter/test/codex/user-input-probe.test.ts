import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../../src/config";
import { threadStartParams } from "../../src/codex/config";
import {
  CodexProcess,
  type Notification,
  type ServerRequest,
} from "../../src/codex/rpc";
import { ModelFixture, sleep, type Behavior } from "../support/model-fixture";
import { TOKEN } from "../support/harness";

// Probe for the clarifying-question card: Codex's request_user_input tool in
// a normal (Default mode) chat on the pin, observed directly. No adapter code
// uses it; the tool is switched on here only, through thread config. It
// checks the facts the feature would be built on: the tool can be offered
// outside Plan mode, the turn waits for the answer, the answer reaches the
// model, and Stop ends a turn whose question is open.

const USER_INPUT = "item/tool/requestUserInput";
const ANSWER = "Executives";
const QUESTION = {
  id: "audience",
  header: "Audience",
  question: "Who is this summary for?",
  options: [
    {
      label: "Finance team (Recommended)",
      description: "Detailed, with account-level numbers.",
    },
    { label: ANSWER, description: "One page, headline numbers only." },
  ],
};
const ask: Behavior = {
  kind: "call",
  name: "request_user_input",
  args: { questions: [QUESTION] },
};

type Item = Record<string, unknown>;
const toolNames = (body: Item): string[] =>
  ((body.tools as Item[] | undefined) ?? []).map((t) =>
    String(t.name ?? t.type),
  );

describe("request_user_input in a Default-mode chat (pinned Codex)", () => {
  const model = new ModelFixture();
  let root = "";
  let workspace = "";
  let codex: CodexProcess;
  const notes: Notification[] = [];
  const asked: ServerRequest[] = [];
  const findings: string[] = [];

  before(async () => {
    await model.start();
    root = await mkdtemp(join(tmpdir(), "runtime-adapter-user-input-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    const { codexBinary } = loadConfig({
      RUNTIME_ADAPTER_TOKEN: TOKEN,
      RUNTIME_STATE_DIR: root,
      // A worktree without its own Codex build can use another checkout's.
      ...(process.env.RUNTIME_CODEX_BINARY
        ? { RUNTIME_CODEX_BINARY: process.env.RUNTIME_CODEX_BINARY }
        : {}),
    });
    codex = new CodexProcess({
      binary: codexBinary,
      home: root,
      workspace,
      rpcMs: 10_000,
    });
    codex.setListener((n) => notes.push(n));
    // Claim only the question; anything else gets the client's default refusal.
    codex.setRequestHandler((r) => {
      if (r.method !== USER_INPUT) return false;
      asked.push(r);
      return true;
    });
    await codex.initialize();
  });

  after(async () => {
    console.log(`\nUSER INPUT PROBE\n${findings.join("\n")}\n`);
    await codex.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  });

  async function startThread() {
    const params = threadStartParams(
      {
        modelName: "fixture-model",
        gatewayUrl: model.url,
        gatewayToken: model.token,
        contextWindow: 100_000,
        autoCompactTokenLimit: 80_000,
      },
      "PROBE_AGENT_PROMPT",
      workspace,
      [],
    );
    const started = await codex.request<{ thread: { id: string } }>(
      "thread/start",
      {
        ...params,
        config: {
          ...params.config,
          "tools.experimental_request_user_input": { enabled: true },
          "features.default_mode_request_user_input": true,
        },
      },
    );
    return started.thread.id;
  }

  async function until(check: () => boolean, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await sleep(20);
    return check();
  }

  async function startTurn(threadId: string, text: string) {
    const r = await codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    return r.turn.id;
  }

  const completed = (threadId: string, turnId: string) =>
    notes.find(
      (n) =>
        n.method === "turn/completed" &&
        n.params.threadId === threadId &&
        (n.params.turn as { id: string }).id === turnId,
    );
  const statusOf = (n: Notification | undefined) =>
    String((n?.params.turn as { status?: unknown } | undefined)?.status);

  test("the tool is offered, the turn waits for the answer, and the answer reaches the model", async () => {
    const threadId = await startThread();
    const first = model.requests.length;
    model.script.push(ask, { kind: "reply", text: "Here is the summary." });
    const turnId = await startTurn(threadId, "Summarise last month's spend.");
    assert.ok(await until(() => asked.length === 1), "Codex asked the client");

    const offered = toolNames(model.requests[first]!.body);
    findings.push(`tools offered: ${offered.join(", ")}`);
    assert.ok(offered.includes("request_user_input"), "tool offered");

    const request = asked[0]!;
    findings.push(
      `isBlocking: ${String(request.params.isBlocking)}; questions: ${JSON.stringify(request.params.questions)}`,
    );

    // A deliberate quiet window, not a wait for an event: with the question
    // open and unanswered, the turn must not finish or call the model again.
    const calls = model.requests.length;
    await sleep(2_000);
    assert.equal(completed(threadId, turnId), undefined, "turn still open");
    assert.equal(model.requests.length, calls, "no model call while waiting");
    findings.push("unanswered for 2 s: turn stayed open, no model call");

    codex.respond(request.id, {
      answers: { [QUESTION.id]: { answers: [ANSWER] } },
    });
    assert.ok(
      await until(() => !!completed(threadId, turnId)),
      "turn finished after the answer",
    );
    const next = model.requests.at(-1)!.body;
    assert.ok(
      JSON.stringify(next.input).includes(ANSWER),
      "answer reached the model",
    );
    findings.push(
      `after the answer: model called again with it; turn ${statusOf(completed(threadId, turnId))}`,
    );
  });

  test("Stop ends a turn whose question is open", async () => {
    asked.length = 0;
    const threadId = await startThread();
    model.script.push(ask);
    const turnId = await startTurn(threadId, "Draft the vendor policy.");
    assert.ok(await until(() => asked.length === 1), "Codex asked the client");

    const seen = notes.length;
    await codex.request("turn/interrupt", { threadId, turnId });
    assert.ok(
      await until(() => !!completed(threadId, turnId)),
      "turn ended after Stop",
    );
    const resolved = notes
      .slice(seen)
      .filter((n) => n.method === "serverRequest/resolved");
    findings.push(
      `after Stop: turn ${statusOf(completed(threadId, turnId))}; serverRequest/resolved: ${JSON.stringify(resolved.map((n) => n.params))}`,
    );
  });
});
