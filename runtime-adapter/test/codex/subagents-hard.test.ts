import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { Harness, completed, readSse, type SseEvent } from "../support/harness";
import { sleep, type Behavior } from "../support/model-fixture";

// Helper agents under hostile conditions, on the real pinned Codex: several
// at once, a helper whose model fails, one that ignores the stop, a Codex
// crash mid-run, and a lead that waits longer than the silence limit.

type Item = Record<string, unknown>;

const isChild = (body: Record<string, unknown>) =>
  ((body.input as Item[] | undefined) ?? []).some(
    (i) => i.type === "agent_message" && i.author === "/root",
  );
// The task the lead gave this helper (see `spawn`): the payload of its
// NEW_TASK message, not the "Task name:" header.
const taskOf = (body: Record<string, unknown>) => {
  for (const i of (body.input as Item[] | undefined) ?? []) {
    if (i.type !== "agent_message" || i.author !== "/root") continue;
    for (const part of (i.content as Item[] | undefined) ?? []) {
      const text = String(part.encrypted_content ?? "");
      const match = /^Task ([a-z0-9]+)$/.exec(text);
      if (match) return match[1]!;
    }
  }
  return "";
};

const collab = (name: string, args: unknown): Behavior => ({
  kind: "call",
  name,
  namespace: "collaboration",
  args,
});
const spawn = (task: string) =>
  collab("spawn_agent", {
    task_name: task,
    message: `Task ${task}`,
    fork_turns: "none",
  });
const wait = () => collab("wait_agent", { timeout_ms: 15_000 });

const ofType = (events: SseEvent[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.data);

function codexChildren(): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid), "codex"])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

describe("helper agents, hard cases (real Codex)", () => {
  const h = new Harness({
    limits: { firstResponseMs: 20_000, silenceMs: 1500, stopMs: 3000 },
  });
  let chat = 0;

  before(() => h.start());
  after(() => h.close());

  function body(overrides: Record<string, unknown> = {}) {
    chat += 1;
    return h.body({
      chatId: `hard${chat}`,
      subAgents: { maxConcurrent: 3 },
      ...overrides,
    });
  }

  function route(lead: Behavior[], child: (task: string) => Behavior) {
    const seen = { lead: 0, child: [] as string[] };
    h.model.router = (b) => {
      if (isChild(b)) {
        const task = taskOf(b);
        seen.child.push(task);
        return child(task);
      }
      seen.lead += 1;
      return lead.shift() ?? { kind: "reply", text: "lead answer" };
    };
    return seen;
  }

  const logs = (event: string) =>
    h.logs.filter((l) => l.event === event).map((l) => l.fields);

  async function until(check: () => boolean, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await sleep(20);
    return check();
  }

  test("three helpers at once: each reported, all billed, run completes", async () => {
    const before = h.model.requests.length;
    // Slow, chunked answers so the three streams overlap.
    const seen = route(
      [spawn("a"), spawn("b"), spawn("c"), wait(), wait(), wait()],
      (task) => ({
        kind: "reply",
        text: `result ${task} `.repeat(6),
        chunk: 5,
        delayMs: 40,
      }),
    );
    const events = await h.run(body());
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "completed");
    assert.deepEqual([...seen.child].sort(), ["a", "b", "c"]);
    const started = ofType(events, "agent.started");
    assert.equal(started.length, 3);
    assert.equal(new Set(started.map((s) => s.agentId)).size, 3);
    const finished = ofType(events, "agent.completed");
    assert.equal(finished.length, 3);
    for (const f of finished) {
      assert.equal(f.status, "completed");
      assert.match(String(f.result), /^result [abc] /);
    }
    // Each helper's result is its own, never another's.
    for (const s of started) {
      const f = finished.find((x) => x.agentId === s.agentId)!;
      const task = String(s.path).split("/").at(-1);
      assert.ok(String(f.result).startsWith(`result ${task}`), String(s.path));
    }
    // Interleaved streams, exact billing: 30 tokens per fixture response.
    const calls = h.model.requests.length - before;
    const usage = done.usage as { turn: { totalTokens: number } };
    assert.equal(usage.turn.totalTokens, 30 * calls);
  });

  test("a helper whose model fails is reported failed; the lead still answers", async () => {
    route([spawn("ok"), spawn("bad"), wait(), wait()], (task) =>
      task === "bad"
        ? { kind: "status", status: 400 }
        : { kind: "reply", text: "fine" },
    );
    const events = await h.run(body());
    h.model.router = undefined;
    assert.equal(completed(events).status, "completed");
    const byPath = new Map(
      ofType(events, "agent.started").map((s) => [s.agentId, s.path]),
    );
    const finished = ofType(events, "agent.completed");
    const bad = finished.find((f) => byPath.get(f.agentId) === "/root/bad");
    const ok = finished.find((f) => byPath.get(f.agentId) === "/root/ok");
    assert.equal(bad?.status, "failed");
    assert.equal(ok?.status, "completed");
  });

  test("a helper stuck before the model answers is stopped within stopMs", async () => {
    route([spawn("deaf"), { kind: "reply", text: "answered early" }], () => ({
      kind: "hangBeforeHeaders",
    }));
    const startedAt = Date.now();
    const events = await h.run(body());
    const took = Date.now() - startedAt;
    h.model.router = undefined;
    assert.equal(completed(events).status, "completed");
    assert.ok(took < 3000 + 4000, `settled in ${took} ms`);
    // Observed: Codex stops a helper's turn even before the provider's
    // headers (unlike the lead's, see sendInterrupt), so no timeout here.
    assert.equal(ofType(events, "agent.completed")[0]?.status, "stopped");
  });

  test("after a helper that ignored the stop, the chat's next reply works", async () => {
    const first = body({ subAgents: { maxConcurrent: 1 } });
    route([spawn("deaf"), { kind: "reply", text: "early" }], () => ({
      kind: "hangBeforeHeaders",
    }));
    const one = await h.run(first);
    assert.equal(completed(one).status, "completed");
    const seen = route([spawn("next"), wait()], () => ({
      kind: "reply",
      text: "second helper ok",
    }));
    const two = await h.run(
      h.body({
        chatId: first.chatId,
        threadId: completed(one).threadId,
        subAgents: { maxConcurrent: 1 },
      }),
    );
    h.model.router = undefined;
    assert.equal(completed(two).status, "completed");
    assert.deepEqual(seen.child, ["next"], "the new helper got a slot");
    assert.equal(ofType(two, "agent.completed")[0]?.status, "completed");
  });

  test("a Codex crash while helpers run fails the run; helpers end stopped; the chat recovers", async () => {
    route([spawn("x"), wait()], () => ({ kind: "hangAfterCreated" }));
    const b = body();
    const res = await h.post("/v1/runs", b);
    let killed = false;
    const events = await readSse(res, (event) => {
      if (event.type === "agent.started" && !killed) {
        killed = true;
        setTimeout(() => {
          for (const pid of codexChildren()) process.kill(pid, "SIGKILL");
        }, 200);
      }
    });
    const done = completed(events);
    assert.equal(done.status, "failed");
    assert.equal((done.error as { code: string }).code, "RUNTIME_ERROR");
    assert.equal(ofType(events, "agent.completed")[0]?.status, "stopped");
    // The next message resumes the thread and can use a helper again.
    const seen = route([spawn("again"), wait()], () => ({
      kind: "reply",
      text: "ok",
    }));
    const next = await h.run(
      h.body({
        chatId: b.chatId,
        threadId: done.threadId,
        subAgents: { maxConcurrent: 3 },
      }),
    );
    h.model.router = undefined;
    assert.equal(completed(next).status, "completed");
    assert.deepEqual(seen.child, ["again"]);
  });

  test("a lead waiting on a helper past silenceMs does not time out", async () => {
    // One piece of text, then 3 s of silence: twice the 1.5 s silence limit.
    route([spawn("slow"), wait()], () => ({
      kind: "reply",
      text: "slow result",
      chunk: 100,
      delayMs: 3000,
    }));
    const events = await h.run(body());
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(ofType(events, "agent.completed")[0]?.status, "completed");
  });

  test("a lead in wait_agent with no helper running does not time out", async () => {
    // Both answers arrive in the first wait; the second has nothing to wait
    // for and blocks for its 3 s timeout, twice the silence limit.
    route(
      [
        spawn("p"),
        spawn("q"),
        collab("wait_agent", { timeout_ms: 15_000 }),
        collab("wait_agent", { timeout_ms: 3_000 }),
      ],
      () => ({ kind: "reply", text: "quick" }),
    );
    const events = await h.run(body());
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
  });

  test("without helpers the silence limit still applies", async () => {
    h.model.router = undefined;
    h.model.script.push({
      kind: "reply",
      text: "x",
      chunk: 100,
      delayMs: 3000,
    });
    const events = await h.run(h.body({ chatId: `hard-plain${++chat}` }));
    assert.equal(completed(events).status, "failed");
    assert.equal(
      (completed(events).error as { code: string }).code,
      "MODEL_TIMEOUT",
    );
  });

  test("no Codex process or helper outlives the suite's runs", async () => {
    assert.ok(await until(() => logs("subagent_started").length > 0));
    // Every helper started was reported finished.
    assert.equal(
      logs("subagent_finished").length,
      logs("subagent_started").length,
    );
  });
});
