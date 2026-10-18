import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import {
  currentTiming,
  detached,
  RequestTiming,
  serverTiming,
  timed,
} from "../../src/common/http/server-timing";
import type { ChatStore } from "../../src/modules/chats/chat-store";
import {
  RunExecutor,
  type Dispatch,
} from "../../src/modules/chats/run-executor";
import type {
  AdapterEvent,
  RuntimeClient,
} from "../../src/modules/chats/runtime-client";

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Server-Timing", () => {
  test("lists steps with their database calls, MongoDB time, connections and the total", async () => {
    const c = clock();
    const timing = new RequestTiming(c.now);
    await timing.step("auth", async () => {
      timing.commandStarted();
      c.advance(250);
      timing.commandEnded();
      timing.commandStarted();
      c.advance(250);
      timing.commandEnded();
    });
    await timing.step("indexes", async () => undefined);
    // Two calls in flight together count their overlap once.
    await timing.step("access", async () => {
      timing.commandStarted();
      timing.commandStarted();
      c.advance(255);
      timing.commandEnded();
      c.advance(5);
      timing.commandEnded();
    });
    timing.connectionOpened(1_100);
    c.advance(10);

    assert.equal(
      timing.header(),
      [
        'auth;dur=500.0;desc="auth (2 db calls)"',
        "indexes;dur=0.0",
        'access;dur=260.0;desc="access (2 db calls)"',
        'db;dur=760.0;desc="MongoDB (4 calls)"',
        'db-connect;dur=1100.0;desc="Opened 1 MongoDB connection"',
        'total;dur=770.0;desc="platform-next total"',
      ].join(", "),
    );
  });

  test("a failed step is still timed, and a call still in flight counts up to now", async () => {
    const c = clock();
    const timing = new RequestTiming(c.now);
    await assert.rejects(
      timing.step("save", async () => {
        timing.commandStarted();
        c.advance(40);
        throw new Error("boom");
      }),
    );
    c.advance(10);
    assert.equal(
      timing.header(),
      'save;dur=40.0;desc="save (1 db call)", db;dur=50.0;desc="MongoDB (1 call)", total;dur=50.0;desc="platform-next total"',
    );
    // An unmatched end never goes below zero.
    timing.commandEnded();
    timing.commandEnded();
    assert.match(timing.header(), /db;dur=50\.0/);
  });

  test("outside a request, timed only runs the work; detached hides the request", async () => {
    assert.equal(currentTiming(), undefined);
    assert.equal(await timed("x", async () => 7), 7);

    const res = fakeResponse();
    let inside: RequestTiming | undefined;
    let outside: RequestTiming | undefined = new RequestTiming();
    serverTiming({} as Request, res, () => {
      inside = currentTiming();
      detached(() => {
        outside = currentTiming();
      });
    });
    assert.ok(inside instanceof RequestTiming);
    assert.equal(outside, undefined);
  });

  test("the header goes out with the response headers, for JSON and for a stream", async () => {
    const server = createServer((req, res) =>
      serverTiming(req as Request, res as unknown as Response, () => {
        void timed("work", () => new Promise((r) => setTimeout(r, 5))).then(
          () => {
            if (req.url === "/stream") {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.write("event: a\ndata: {}\n\n");
              // A step after the headers went out is not in them.
              void timed("late", async () => undefined).then(() => res.end());
            } else res.end("{}");
          },
        );
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ["/json", "/stream"]) {
        const res = await fetch(`${base}${path}`);
        await res.text();
        const header = res.headers.get("server-timing") ?? "";
        assert.match(
          header,
          /^work;dur=\d+\.\d, db;dur=0\.0;desc="MongoDB \(0 calls\)", total;dur=\d+\.\d;desc="platform-next total"$/,
          path,
        );
        assert.doesNotMatch(header, /late/);
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("a chat run's reader does not run inside the request that started it", async () => {
    const seen: Array<[string, RequestTiming | undefined]> = [];
    const store = {
      markAccepted: async () => void seen.push(["accepted", currentTiming()]),
      renewLease: async () => true,
      markUncertain: async () => undefined,
      settleWithRetry: async () => {
        seen.push(["settled", currentTiming()]);
        return { run: {}, messages: [] };
      },
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "run.accepted",
          data: { threadId: "thread-1", turnId: "turn-1" },
        };
        yield {
          seq: 2,
          type: "run.completed",
          data: { status: "completed", delivery: "accepted", items: [] },
        };
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const runId = new ObjectId();
    const dispatch: Dispatch = {
      dbName: "truex_next_t",
      chatId: new ObjectId(),
      runId,
      ownerId: new ObjectId(),
      replySeq: 2,
      ref: { tenantId: "t", chatId: "c" },
      mode: "start",
      body: {} as Dispatch["body"],
    };
    let started: RequestTiming | undefined;
    serverTiming({} as Request, fakeResponse(), () => {
      started = currentTiming();
      executor.begin(dispatch);
    });
    await executor.drain(5_000);

    assert.ok(started instanceof RequestTiming);
    assert.deepEqual(seen, [
      ["accepted", undefined],
      ["settled", undefined],
    ]);
  });
});

function fakeResponse(): Response {
  const res = {
    headersSent: false,
    setHeader: () => res,
    writeHead: () => res,
  };
  return res as unknown as Response;
}
