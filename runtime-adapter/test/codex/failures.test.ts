import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  Harness,
  completed,
  readSse,
  streamedText,
  type SseEvent,
} from "../support/harness";
import { sleep } from "../support/model-fixture";

// Stop, watchdog, provider failures, crashes, restarts and lost storage,
// each against the real pinned Codex.

const SLOW = {
  kind: "reply" as const,
  text: "word ".repeat(80),
  chunk: 5,
  delayMs: 40,
};

function errorCode(events: SseEvent[]): unknown {
  return (completed(events).error as { code?: string } | null)?.code;
}

async function firstThread(h: Harness, chatId: string): Promise<string> {
  const events = await h.run(h.body({ chatId }));
  assert.equal(completed(events).status, "completed");
  return String(events[0]!.data.threadId);
}

describe("stop", () => {
  const h = new Harness({ limits: { stopMs: 3000 } });
  before(() => h.start());
  after(() => h.close());

  test("stop mid-reply settles as stopped and returns the partial text", async () => {
    const threadId = await firstThread(h, "stop1");
    h.model.script.push(SLOW);
    const body = h.body({ chatId: "stop1", threadId });
    const res = await h.post("/v1/runs", body);
    const stops: number[] = [];
    const events = await readSse(res, async (event) => {
      if (event.type === "text.delta" && stops.length === 0) {
        // Stop twice in a row: Codex never answers a second pending
        // interrupt, so the adapter must not forward it.
        const chat = { tenantId: "tenant1", chatId: "stop1" };
        const [a, b] = await Promise.all([
          h.stop(String(body.runId), chat),
          h.stop(String(body.runId), chat),
        ]);
        stops.push(a.status, b.status);
      }
    });
    assert.deepEqual(stops, [202, 202]);
    const done = completed(events);
    assert.equal(done.status, "stopped");
    assert.equal(done.error, null);
    const partial = (
      done.items as Array<{ text: string; completed: boolean }>
    )[0];
    assert.ok(partial && partial.text.length > 0 && !partial.completed);
    assert.equal(partial.text, streamedText(events));

    // Stopping a finished run is a no-op that reports its outcome.
    const again = await h.stop(String(body.runId), {
      tenantId: "tenant1",
      chatId: "stop1",
    });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { status: "stopped" });

    // The chat accepts the next message right away.
    const next = await h.run(h.body({ chatId: "stop1", threadId }));
    assert.equal(completed(next).status, "completed");
  });

  test("stop before the model answers settles as stopped", async () => {
    const threadId = await firstThread(h, "stop2");
    h.model.script.push({ kind: "hangBeforeHeaders" });
    const body = h.body({ chatId: "stop2", threadId });
    const res = await h.post("/v1/runs", body);
    const requests = h.model.requests.length;
    const events = await readSse(res, async (event) => {
      if (event.type !== "run.accepted") return;
      // Stop while Codex waits for the provider's response headers.
      while (h.model.requests.length === requests) await sleep(10);
      await h.stop(String(body.runId), {
        tenantId: "tenant1",
        chatId: "stop2",
      });
    });
    assert.equal(completed(events).status, "stopped");
    assert.equal(
      h.logs.filter((l) => l.event === "interrupt_timeout").length,
      0,
      "settled without waiting",
    );
    // The restarted process resumes for the next message.
    const next = await h.run(h.body({ chatId: "stop2", threadId }));
    assert.equal(next[0]!.data.resumed, true);
    assert.equal(completed(next).status, "completed");
  });
});

describe("watchdog and provider failures", () => {
  const h = new Harness({
    limits: { firstResponseMs: 1500, silenceMs: 1500, stopMs: 3000 },
  });
  before(() => h.start());
  after(() => h.close());

  test("a provider that never answers fails with MODEL_TIMEOUT", async () => {
    const threadId = await firstThread(h, "w1");
    h.model.script.push({ kind: "hangBeforeHeaders" });
    const started = Date.now();
    const events = await h.run(h.body({ chatId: "w1", threadId }));
    assert.equal(completed(events).status, "failed");
    assert.equal(errorCode(events), "MODEL_TIMEOUT");
    assert.ok(Date.now() - started < 8000);
    // The chat is usable afterwards.
    assert.equal(
      completed(await h.run(h.body({ chatId: "w1", threadId }))).status,
      "completed",
    );
  });

  test("a stream that goes silent mid-reply fails with MODEL_TIMEOUT", async () => {
    const threadId = await firstThread(h, "w2");
    h.model.script.push({ kind: "hangAfterCreated" });
    const events = await h.run(h.body({ chatId: "w2", threadId }));
    assert.equal(errorCode(events), "MODEL_TIMEOUT");
  });

  test("a provider that keeps returning 500 fails with PROVIDER_ERROR", async () => {
    const threadId = await firstThread(h, "w3");
    for (let i = 0; i < 10; i++)
      h.model.script.push({ kind: "status", status: 500 });
    const events = await h.run(h.body({ chatId: "w3", threadId }));
    const done = completed(events);
    assert.equal(done.status, "failed");
    assert.deepEqual(done.error, {
      code: "PROVIDER_ERROR",
      message: "The model provider returned an error. Try again.",
      retryable: true,
    });
    h.model.script.length = 0;
  });

  test("a context overflow fails with CONTEXT_FULL", async () => {
    const threadId = await firstThread(h, "w4");
    h.model.script.push({ kind: "failed", code: "context_length_exceeded" });
    const events = await h.run(h.body({ chatId: "w4", threadId }));
    assert.equal(errorCode(events), "CONTEXT_FULL");
    h.model.script.length = 0;
  });
});

describe("restart, crash and storage", () => {
  const h = new Harness({ limits: { stopMs: 3000 } });
  before(() => h.start());
  after(() => h.close());

  test("after an adapter restart the chat resumes the same thread with its prompt", async () => {
    const threadId = await firstThread(h, "r1");
    await h.restart();
    h.model.script.push({ kind: "reply", text: "after restart" });
    const events = await h.run(
      h.body({ chatId: "r1", threadId, agentPrompt: "NEW PROMPT IGNORED" }),
    );
    assert.equal(events[0]!.data.resumed, true);
    assert.equal(events[0]!.data.threadId, threadId);
    assert.equal(completed(events).status, "completed");
    const sent = JSON.stringify(h.model.lastRequest().body);
    assert.ok(sent.includes("AGENT_PROMPT_MARKER"), "original prompt kept");
    assert.ok(
      !sent.includes("NEW PROMPT IGNORED"),
      "a new prompt is never applied on resume",
    );
    assert.ok(sent.includes("Hello from the fixture."), "history kept");
    assert.doesNotMatch(
      JSON.stringify(h.model.lastRequest().body.input),
      /permissions instructions|sandbox_mode|environment_context/i,
      "Codex adds no permissions or environment block on resume",
    );
    assert.ok(!sent.includes(h.stateDir), "no host path reaches the model");
  });

  test("history after a restart reads the thread without resuming it", async () => {
    const body = h.body({ chatId: "r8" });
    await h.run(body);
    await h.restart();
    const requests = h.model.requests.length;
    const res = await h.fetch("/v1/chats/r8/history?tenantId=tenant1");
    const { turns } = (await res.json()) as {
      turns: Array<{ clientMessageId: string; text: string }>;
    };
    assert.equal(
      turns[0]!.clientMessageId,
      (body.input as { clientMessageId: string }).clientMessageId,
    );
    assert.equal(turns[0]!.text, "Hello from the fixture.");
    assert.equal(h.model.requests.length, requests, "no model call");
  });

  test("a first message retried without its threadId reuses the recorded thread", async () => {
    const threadId = await firstThread(h, "r2");
    const events = await h.run(h.body({ chatId: "r2", threadId: null }));
    assert.equal(events[0]!.data.threadId, threadId);
  });

  test("a Codex crash mid-reply fails the run, and the next message resumes", async () => {
    const threadId = await firstThread(h, "r3");
    h.model.script.push(SLOW);
    const res = await h.post("/v1/runs", h.body({ chatId: "r3", threadId }));
    let killed = false;
    const events = await readSse(res, (event) => {
      if (event.type === "text.delta" && !killed) {
        killed = true;
        for (const pid of codexChildren()) process.kill(pid, "SIGKILL");
      }
    });
    const done = completed(events);
    assert.equal(done.status, "failed");
    assert.equal(errorCode(events), "RUNTIME_ERROR");
    assert.equal(done.delivery, "accepted");
    assert.ok(
      (done.items as Array<{ text: string }>)[0]!.text.length > 0,
      "partial text kept",
    );

    const next = await h.run(h.body({ chatId: "r3", threadId }));
    assert.equal(next[0]!.data.resumed, true);
    assert.equal(completed(next).status, "completed");
  });

  test("a thread whose storage is gone is THREAD_LOST and nothing is sent", async () => {
    const threadId = await firstThread(h, "r4");
    await h.restart();
    await rm(join(h.stateDir, "t", "tenant1", "c", "r4"), { recursive: true });
    const requests = h.model.requests.length;
    const events = await h.run(h.body({ chatId: "r4", threadId }));
    assert.equal(errorCode(events), "THREAD_LOST");
    assert.equal(completed(events).delivery, "none");
    assert.equal(h.model.requests.length, requests);
  });

  test("a thread ID from another chat is refused", async () => {
    const threadId = await firstThread(h, "r5");
    await firstThread(h, "r6");
    const events = await h.run(h.body({ chatId: "r6", threadId }));
    assert.equal(errorCode(events), "THREAD_MISMATCH");
  });

  test("the gateway token is never written to the chat's storage", async () => {
    await firstThread(h, "r7");
    const hits = await grep(join(h.stateDir, "t"), h.model.token);
    assert.deepEqual(hits, []);
  });
});

describe("reconnect", () => {
  const h = new Harness({ limits: { bufferEvents: 5 } });
  before(() => h.start());
  after(() => h.close());

  test("a reconnect replays after the cursor, or sends a snapshot when it is too old", async () => {
    h.model.script.push({
      kind: "reply",
      text: "abcdefghijklmnopqrstuvwxyz",
      chunk: 2,
    });
    const body = h.body({ chatId: "re1" });
    const all = await h.run(body);
    const query = `tenantId=tenant1&chatId=re1`;
    const last = all.at(-1)!.seq;

    const recent = await readSse(
      await h.fetch(
        `/v1/runs/${String(body.runId)}/events?${query}&after=${last - 2}`,
      ),
    );
    assert.deepEqual(
      recent.map((e) => e.seq),
      [last - 1, last],
    );

    const old = await readSse(
      await h.fetch(`/v1/runs/${String(body.runId)}/events?${query}&after=1`),
    );
    assert.deepEqual(
      old.map((e) => e.type),
      ["run.snapshot", "run.completed"],
    );
    const items = old[0]!.data.items as Array<{ text: string }>;
    assert.equal(items[0]!.text, "abcdefghijklmnopqrstuvwxyz");
  });
});

describe("capacity and drain", () => {
  const h = new Harness({ maxProcesses: 1 });
  before(() => h.start());
  after(() => h.close());

  test("at capacity an idle process is stopped to make room; a busy one is not", async () => {
    await firstThread(h, "c1");
    // c1 is idle, so c2 takes its slot.
    await firstThread(h, "c2");
    h.model.script.push(SLOW);
    const res = await h.post(
      "/v1/runs",
      h.body({ chatId: "c2", threadId: null }),
    );
    const reading = readSse(res);
    await sleep(200);
    const refused = await h.post("/v1/runs", h.body({ chatId: "c3" }));
    assert.equal(refused.status, 503);
    assert.deepEqual(((await refused.json()) as { error: unknown }).error, {
      code: "RUNTIME_BUSY",
      message: "The assistant is at capacity. Try again shortly.",
      retryable: true,
    });
    await reading;
    assert.equal(h.manager.stats.processes, 1);
  });

  test("drain refuses new runs and stops active ones as RUNTIME_SHUTDOWN", async () => {
    h.model.script.push({ ...SLOW, delayMs: 200 });
    const res = await h.post("/v1/runs", h.body({ chatId: "c2" }));
    const reading = readSse(res);
    await sleep(300);
    const draining = h.manager.drain(100);
    const refused = await h.post("/v1/runs", h.body({ chatId: "c9" }));
    assert.equal(refused.status, 503);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "DRAINING",
    );
    const events = await reading;
    assert.equal(errorCode(events), "RUNTIME_SHUTDOWN");
    await draining;
    assert.equal(codexChildren().length, 0, "every Codex process stopped");
  });
});

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

async function grep(
  dir: string,
  needle: string,
  hits: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await grep(path, needle, hits);
    else if (
      (await stat(path)).size < 50e6 &&
      (await readFile(path)).includes(needle)
    )
      hits.push(path);
  }
  return hits;
}
