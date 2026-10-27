import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Auth, Authorized } from "../lib/auth.ts";
import { bumpIdentityGeneration, setIdentityScope } from "../lib/identity.ts";
import {
  createSseParser,
  followRun,
  MAX_RECONNECTS,
  type StreamEnd,
} from "../lib/tenant-chat-stream.ts";

const CHAT = "64b7f0c2a1b2c3d4e5f60c01";
const RUN = "64b7f0c2a1b2c3d4e5f60d01";

beforeEach(() => signInForTest());

const frame = (type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

// A response whose body is the given chunks, optionally left open.
function sse(chunks: string[], open = false): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!open) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function fakeAuth(answers: Array<() => Authorized | Promise<Authorized>>) {
  const urls: string[] = [];
  const auth = {
    async request(url: string) {
      urls.push(url);
      const next = answers.shift();
      if (!next)
        return { kind: "response", response: sse([], true) } as Authorized;
      return next();
    },
  } as unknown as Auth;
  return { auth, urls };
}

const response = (res: Response) => () =>
  ({ kind: "response", response: res }) as Authorized;

function follow(auth: Auth, silenceMs = 5_000) {
  const events: Array<{ type: string; data: unknown }> = [];
  const connections: boolean[] = [];
  let resolveEnd!: (end: StreamEnd) => void;
  const ended = new Promise<StreamEnd>((r) => (resolveEnd = r));
  const stop = followRun(
    CHAT,
    RUN,
    {
      onEvent: (e) => events.push(e),
      onConnection: (c) => connections.push(c),
      onEnd: resolveEnd,
    },
    { auth, sleep: async () => {}, silenceMs },
  );
  return { events, connections, ended, stop };
}

test("SSE frames survive arbitrary chunking, CRLF and comments", () => {
  const frames: Array<{ type: string; data: string }> = [];
  const parser = createSseParser((f) => frames.push(f));
  const text =
    ': hb\r\n\r\nevent: delta\r\ndata: {"a":1}\r\n\r\nevent: x\ndata: one\ndata: two\n\n';
  for (const ch of text) parser.push(ch);
  assert.deepEqual(frames, [
    { type: "delta", data: '{"a":1}' },
    { type: "x", data: "one\ntwo" },
  ]);
});

test("follows a reply to saved, addressed to this tab's tenant", async () => {
  const { auth, urls } = fakeAuth([
    response(
      sse([
        frame("snapshot", { runId: RUN, phase: "waiting", items: [] }),
        ": hb\n\n",
        frame("delta", { itemId: "a", text: "Hi" }),
        frame("saved", { run: { id: RUN } }),
        frame("delta", { itemId: "a", text: "late" }),
      ]),
    ),
  ]);
  const { events, ended } = follow(auth);
  const end = await ended;
  assert.equal(end.kind, "saved");
  assert.deepEqual(
    events.map((e) => e.type),
    ["snapshot", "delta"],
  );
  assert.equal(
    urls[0],
    `/api/v1/chats/${CHAT}/runs/${RUN}/stream?tenantId=${TENANT_ID}`,
  );
});

test("a dropped stream reconnects and the snapshot starts over", async () => {
  const { auth, urls } = fakeAuth([
    response(sse([frame("delta", { itemId: "a", text: "Hel" })])),
    () => {
      throw new TypeError("network down");
    },
    response(
      sse([
        frame("snapshot", {
          runId: RUN,
          items: [{ itemId: "a", text: "Hello" }],
        }),
        frame("saved", { run: { id: RUN } }),
      ]),
    ),
  ]);
  const { events, connections, ended } = follow(auth);
  assert.equal((await ended).kind, "saved");
  assert.equal(urls.length, 3);
  assert.deepEqual(connections, [true, false, false, true]);
  assert.equal(events.at(-1)?.type, "snapshot");
});

test("a missing reply ends as notFound; the platform's end means reload", async () => {
  const gone = fakeAuth([response(new Response("{}", { status: 404 }))]);
  assert.equal((await follow(gone.auth).ended).kind, "notFound");
  const unavailable = fakeAuth([
    response(sse([frame("end", { reason: "unavailable" })], true)),
  ]);
  assert.equal((await follow(unavailable.auth).ended).kind, "unavailable");
  const forbidden = fakeAuth([response(new Response("{}", { status: 403 }))]);
  assert.equal((await follow(forbidden.auth).ended).kind, "signedOut");
});

test("an aged-out token reconnects instead of ending", async () => {
  const { auth, urls } = fakeAuth([
    response(sse([frame("end", { reason: "reauthenticate" })], true)),
    response(sse([frame("saved", { run: { id: RUN } })])),
  ]);
  assert.equal((await follow(auth).ended).kind, "saved");
  assert.equal(urls.length, 2);
});

test("gives up after repeated failures with nothing received", async () => {
  const failing = Array.from(
    { length: MAX_RECONNECTS + 1 },
    () => () => ({ kind: "unavailable" }) as Authorized,
  );
  const { auth, urls } = fakeAuth(failing);
  assert.equal((await follow(auth).ended).kind, "lost");
  assert.equal(urls.length, MAX_RECONNECTS + 1);
});

test("a silent connection is dropped and reopened", async () => {
  const { auth, urls } = fakeAuth([
    response(sse([], true)),
    response(sse([frame("saved", { run: { id: RUN } })])),
  ]);
  assert.equal((await follow(auth, 30).ended).kind, "saved");
  assert.equal(urls.length, 2);
});

test("after stop, or a change of workspace, nothing more is reported", async () => {
  for (const change of [
    (stop: () => void) => stop(),
    () => {
      bumpIdentityGeneration();
      setIdentityScope("64b7f0c2a1b2c3d4e5f60718", TENANT_ID);
    },
  ]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { auth } = fakeAuth([
      async () => {
        await gate;
        return {
          kind: "response",
          response: sse([
            frame("delta", { itemId: "a", text: "x" }),
            frame("saved", {}),
          ]),
        } as Authorized;
      },
    ]);
    const { events, ended, stop } = follow(auth);
    change(stop);
    release();
    const result = await Promise.race([
      ended.then(() => "ended"),
      new Promise((r) => setTimeout(() => r("quiet"), 50)),
    ]);
    assert.equal(result, "quiet");
    assert.equal(events.length, 0);
  }
});

test("stop mid-reply releases a body that ignores the abort signal", async () => {
  let cancelled = false;
  const open = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(frame("delta", { itemId: "a", text: "x" })),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const { auth } = fakeAuth([response(open)]);
  const { events, ended, stop } = follow(auth);
  while (!events.length) await new Promise((r) => setTimeout(r, 1));
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cancelled, true);
  const result = await Promise.race([
    ended.then(() => "ended"),
    new Promise((r) => setTimeout(() => r("quiet"), 30)),
  ]);
  assert.equal(result, "quiet");
});
