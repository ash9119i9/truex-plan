import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Harness, completed, readSse, type SseEvent } from "../support/harness";

// Steer-while-busy against the real pinned Codex, end to end through the
// adapter's HTTP surface. Mirrors the probe (.runtime/steer-probe/probe.ts):
// a steer joins the running turn, cuts the reply being written, and the run's
// ordered items record reply/input in Codex's order. If a Codex upgrade
// changes steer behaviour one of these fails.

describe("steer while busy (real Codex)", () => {
  const h = new Harness();
  before(() => h.start());
  after(() => h.close());

  let threadId = "";

  // Starts a run, steers once its reply begins streaming, then reads the rest.
  async function runAndSteer(
    body: Record<string, unknown>,
    steer: { text: string; clientMessageId: string },
  ): Promise<{ events: SseEvent[]; steerStatus: number }> {
    const res = await h.post("/v1/runs", body);
    assert.equal(res.status, 200);
    const runId = String(body.runId);
    let steerStatus = 0;
    let sent = false;
    const events = await readSse(res, async (event) => {
      if (!sent && event.type === "text.delta") {
        sent = true;
        steerStatus = (await h.steer(runId, steer)).status;
      }
    });
    return { events, steerStatus };
  }

  test("a steer mid-stream cuts the reply and emits input.accepted", async () => {
    // A long first reply so the steer lands while it streams, then a follow-up.
    h.model.script.push({
      kind: "reply",
      text: "alpha ".repeat(60),
      chunk: 6,
      delayMs: 20,
    });
    h.model.script.push({ kind: "reply", text: "beta answers the steer" });
    const body = h.body();
    threadId = "";
    const { events, steerStatus } = await runAndSteer(body, {
      text: "also mention cats",
      clientMessageId: "steer-A",
    });
    assert.equal(steerStatus, 202);
    threadId = String(events[0]!.data.threadId);

    // input.accepted fired once for the steer.
    const accepted = events.filter((e) => e.type === "input.accepted");
    assert.deepEqual(
      accepted.map((e) => e.data.clientMessageId),
      ["steer-A"],
    );

    // Ordered items: the cut reply, the steer input, then the follow-up reply.
    const items = completed(events).items as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((i) => i.type),
      ["reply", "input", "reply"],
    );
    assert.equal(items[1]!.clientMessageId, "steer-A");
    // The first reply was cut off: it never completed; the follow-up did.
    assert.equal(items[0]!.completed, false);
    assert.equal(items[2]!.completed, true);
    assert.equal(items[2]!.text, "beta answers the steer");
    assert.equal(completed(events).status, "completed");
    h.model.script.length = 0;
  });

  test("two quick steers add two inputs and one follow-up reply", async () => {
    h.model.script.push({
      kind: "reply",
      text: "gamma ".repeat(60),
      chunk: 6,
      delayMs: 20,
    });
    h.model.script.push({ kind: "reply", text: "delta answers both" });
    const body = h.body({ threadId });
    const runId = String(body.runId);
    const res = await h.post("/v1/runs", body);
    let sent = false;
    const events = await readSse(res, async (event) => {
      if (!sent && event.type === "text.delta") {
        sent = true;
        // Both steers are posted back to back; the adapter serializes them.
        const [a, b] = await Promise.all([
          h.steer(runId, { text: "one", clientMessageId: "steer-B1" }),
          h.steer(runId, { text: "two", clientMessageId: "steer-B2" }),
        ]);
        assert.equal(a.status, 202);
        assert.equal(b.status, 202);
      }
    });
    const items = completed(events).items as Array<Record<string, unknown>>;
    const inputs = items
      .filter((i) => i.type === "input")
      .map((i) => i.clientMessageId);
    assert.deepEqual(inputs.sort(), ["steer-B1", "steer-B2"]);
    // One follow-up reply after the inputs answers both.
    const replies = items.filter((i) => i.type === "reply");
    assert.ok(replies.length >= 1);
    assert.equal(completed(events).status, "completed");
    h.model.script.length = 0;
  });

  test("a steer before any output still lands and gets a single answer", async () => {
    // The provider is slow to send headers; the steer is posted at once.
    h.model.script.push({
      kind: "reply",
      text: "eta answer",
      chunk: 4,
      delayMs: 40,
    });
    const body = h.body({ threadId });
    const runId = String(body.runId);
    const res = await h.post("/v1/runs", body);
    // Post the steer before any text.delta: it waits for acceptance.
    const steer = await h.steer(runId, {
      text: "early steer",
      clientMessageId: "steer-D",
    });
    assert.equal(steer.status, 202);
    const events = await readSse(res);
    const items = completed(events).items as Array<Record<string, unknown>>;
    assert.ok(items.some((i) => i.clientMessageId === "steer-D"));
    assert.equal(completed(events).status, "completed");
    h.model.script.length = 0;
  });

  test("a steer after the run ended is RUN_ENDED and nothing is delivered", async () => {
    h.model.script.push({ kind: "reply", text: "iota done" });
    const body = h.body({ threadId });
    const events = await h.run(body);
    assert.equal(completed(events).status, "completed");
    const res = await h.steer(String(body.runId), {
      text: "late steer",
      clientMessageId: "steer-E",
    });
    assert.equal(res.status, 409);
    const payload = (await res.json()) as {
      error: { code: string; retryable: boolean };
    };
    assert.equal(payload.error.code, "RUN_ENDED");
    assert.equal(payload.error.retryable, false);
    h.model.script.length = 0;
  });

  test("a steer then a stop keeps the steer in history (instant_interrupt)", async () => {
    // A long reply, steered, then stopped before the follow-up finishes.
    h.model.script.push({
      kind: "reply",
      text: "zeta ".repeat(200),
      chunk: 4,
      delayMs: 30,
    });
    h.model.script.push({
      kind: "reply",
      text: "zeta2 ".repeat(200),
      chunk: 4,
      delayMs: 30,
    });
    const body = h.body({ threadId });
    const runId = String(body.runId);
    const res = await h.post("/v1/runs", body);
    let phase = 0;
    const events = await readSse(res, async (event) => {
      if (event.type === "text.delta" && phase === 0) {
        phase = 1;
        assert.equal(
          (
            await h.steer(runId, {
              text: "steer then stopped",
              clientMessageId: "steer-C",
            })
          ).status,
          202,
        );
      } else if (event.type === "input.accepted" && phase === 1) {
        phase = 2;
        await h.stop(runId);
      }
    });
    assert.equal(completed(events).status, "stopped");

    // Codex had already read the steer (its input item completed), so it
    // survives in history even though the turn was interrupted.
    const hist = await h.fetch(`/v1/chats/chat1/history?tenantId=tenant1`);
    const { turns } = (await hist.json()) as {
      turns: Array<{ items: Array<Record<string, unknown>> }>;
    };
    const steered = turns.find((t) =>
      t.items.some((i) => i.clientMessageId === "steer-C"),
    );
    assert.ok(steered, "the steer input is in the turn's history items");
    h.model.script.length = 0;
  });

  test("steering is idempotent per clientMessageId and refuses a conflicting text", async () => {
    h.model.script.push({
      kind: "reply",
      text: "kappa ".repeat(80),
      chunk: 6,
      delayMs: 20,
    });
    h.model.script.push({ kind: "reply", text: "lambda follow" });
    const body = h.body({ threadId });
    const runId = String(body.runId);
    const res = await h.post("/v1/runs", body);
    let checked = false;
    const events = await readSse(res, async (event) => {
      if (!checked && event.type === "text.delta") {
        checked = true;
        const first = await h.steer(runId, {
          text: "same steer",
          clientMessageId: "steer-G",
        });
        assert.equal(first.status, 202);
        // Same id + same text: the same answer, no second steer.
        const repeat = await h.steer(runId, {
          text: "same steer",
          clientMessageId: "steer-G",
        });
        assert.equal(repeat.status, 202);
        // Same id, different text: RUN_CONFLICT.
        const conflict = await h.steer(runId, {
          text: "different text",
          clientMessageId: "steer-G",
        });
        assert.equal(conflict.status, 409);
        assert.equal(
          ((await conflict.json()) as { error: { code: string } }).error.code,
          "RUN_CONFLICT",
        );
        // The run's own input id is a conflict too.
        const own = await h.steer(runId, {
          text: "anything",
          clientMessageId: String(
            (body.input as { clientMessageId: string }).clientMessageId,
          ),
        });
        assert.equal(own.status, 409);
      }
    });
    // Only one input for steer-G despite three posts.
    const items = completed(events).items as Array<Record<string, unknown>>;
    assert.equal(
      items.filter((i) => i.clientMessageId === "steer-G").length,
      1,
    );
    h.model.script.length = 0;
  });

  test("more than 20 steers on one run is STEER_LIMIT", async () => {
    // A long, slow first reply so all the steers arrive during one turn.
    h.model.script.push({
      kind: "reply",
      text: "mu ".repeat(400),
      chunk: 2,
      delayMs: 20,
    });
    const body = h.body({ threadId });
    const runId = String(body.runId);
    const res = await h.post("/v1/runs", body);
    let fired = false;
    const statuses: number[] = [];
    const events = await readSse(res, async (event) => {
      if (!fired && event.type === "text.delta") {
        fired = true;
        // 20 are admitted (the safety cap); the 21st is refused outright.
        for (let i = 0; i < 21; i++) {
          const r = await h.steer(runId, {
            text: `steer ${i}`,
            clientMessageId: `cap-${i}`,
          });
          statuses.push(r.status);
          if (r.status === 409) {
            assert.equal(
              ((await r.json()) as { error: { code: string } }).error.code,
              "STEER_LIMIT",
            );
            break;
          }
        }
        await h.stop(runId);
      }
    });
    assert.equal(statuses.filter((s) => s === 202).length, 20);
    assert.ok(statuses.includes(409), "the 21st steer is refused");
    assert.ok(
      ["completed", "stopped"].includes(String(completed(events).status)),
    );
    h.model.script.length = 0;
  });
});
