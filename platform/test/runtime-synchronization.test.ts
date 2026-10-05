import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkStreamMixin } from "@smithy/core/serde";
import { ThreadManager } from "../../agent-core/src/manager";
import { createAgentCoreApp } from "../../agent-core/src/agentcore";
import {
  runtimeWindowQuery,
  runtimeSyncOption,
} from "../../shared/runtime-read-options";
import { RuntimeTransport } from "../src/runtime-transport";
import { publicEvent } from "../src/public";
import {
  advanceSourceSync,
  beginSourceSync,
} from "../../frontend/lib/source-sync";

// Source runtime and invocation bridge are real; only the provider and AWS
// network boundary are replaced. No user session, provider or cloud calls.
test("HTTP and AgentCore synchronization deliver identical replay/operational envelopes and zero-gap authority", async (t) => {
  class FakeRuntime extends EventEmitter {
    async request(method: string, params?: any) {
      if (method === "thread/resume")
        return {
          thread: {
            id: params.threadId,
            turns: [
              {
                id: "restored-turn",
                status: "inProgress",
                items: [
                  { id: "restored-item", type: "agentMessage", text: "prefix" },
                ],
              },
            ],
          },
        };
      return method === "thread/start" ? { thread: { id: "thread" } } : {};
    }
    respond() {}
  }
  const runtime = new FakeRuntime();
  const home = mkdtempSync(join(tmpdir(), "runtime-synchronization-"));
  const manager = new ThreadManager(runtime, home, 20, 500);
  await manager.create({});
  const initial = manager.snapshot("thread").cursor;
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread", turn: { id: "turn" } },
  });
  runtime.emit("serverRequest", {
    id: 1,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      questions: [
        {
          id: "fixture",
          header: "Approve",
          question: "Allow the fixture action?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Allow", description: "Run once." },
            { label: "Cancel", description: "Skip it." },
          ],
        },
      ],
    },
  });
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      delta: "😀answer",
    },
  });
  const current = manager.snapshot("thread").cursor;
  const core = express();
  core.get("/threads/:id/events", (req, res) =>
    manager.subscribe(
      req.params.id,
      res,
      req.get("Last-Event-ID") || String(req.query.cursor || "") || undefined,
      {
        window: runtimeWindowQuery(req.query.window),
        sync: runtimeSyncOption("GET", req.path, req.query.sync),
      },
    ),
  );
  const coreServer = core.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => coreServer.once("listening", resolve));
  const coreUrl = `http://127.0.0.1:${(coreServer.address() as any).port}`;
  const invocationServer = createAgentCoreApp({ coreUrl }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) =>
    invocationServer.once("listening", resolve),
  );
  const invokeUrl = `http://127.0.0.1:${(invocationServer.address() as any).port}/invocations`;
  t.after(async () => {
    manager.close();
    await Promise.all(
      [coreServer, invocationServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    rmSync(home, { recursive: true, force: true });
  });
  async function untilMarker(response: Response, type = "sync.completed") {
    const reader = response.body!.getReader();
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const marker = text.indexOf(`"type":"${type}"`);
        if (marker >= 0 && text.indexOf("\n\n", marker) >= 0) break;
        const next = await reader.read();
        assert.equal(next.done, false, "stream ended before synchronization");
        text += decoder.decode(next.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    return text;
  }
  const envelopes: any[] = [];
  const sessionId = randomUUID();
  const owner =
    "arn:aws:bedrock-agentcore:us-east-1:502055890667:runtime/test_runtime";
  const transport = new RuntimeTransport(async (_region, command, signal) => {
    const payload = JSON.parse(
      Buffer.from(command.input.payload as Uint8Array).toString(),
    );
    envelopes.push(payload);
    const response = await fetch(invokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await untilMarker(
      response,
      payload.path.includes("/restored/") ? "snapshot" : "sync.completed",
    );
    return {
      $metadata: { httpStatusCode: response.status },
      statusCode: response.status,
      contentType: "text/event-stream",
      runtimeSessionId: sessionId,
      response: sdkStreamMixin(
        Readable.from([Buffer.from(text)], { objectMode: false }),
      ),
    };
  });
  const parse = (text: string) =>
    text.split("\n\n").flatMap((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      return data ? [JSON.parse(data.slice(6))] : [];
    });
  const publicFrames = (events: any[]) =>
    events
      .map(publicEvent)
      .filter(Boolean)
      .map((event) => {
        assert.equal(
          Object.hasOwn(event, "threadId"),
          false,
          "internal thread IDs do not cross the public wire",
        );
        return { ...event, threadId: sessionId };
      });
  const coldFrames = parse(
    await untilMarker(
      await transport.request({
        owner: coreUrl,
        path: "/threads/thread/events",
        window: true,
        sync: "v1",
      }),
    ),
  );
  const paired = advanceSourceSync(
    beginSourceSync(null, true),
    publicFrames(coldFrames),
  );
  assert.equal(paired.failure, null);
  assert.equal(paired.state.phase, "ready");
  assert.equal(paired.state.pair?.threadId, sessionId);
  assert.equal(paired.state.pair?.cursor, current);
  assert.equal(paired.operational?.pending.length, 1);
  for (const cursor of [initial, current]) {
    const http = parse(
      await untilMarker(
        await transport.request({
          owner: coreUrl,
          path: "/threads/thread/events",
          cursor,
          window: true,
          sync: "v1",
        }),
      ),
    );
    const deployed = parse(
      await untilMarker(
        await transport.request({
          owner,
          sessionId,
          path: "/threads/thread/events",
          cursor,
          window: true,
          sync: "v1",
        }),
      ),
    );
    // Marker timestamp is publication time; every projection/cursor field agrees.
    const comparable = (events: any[]) =>
      events.map(({ at: _at, ...event }) => event);
    assert.deepEqual(comparable(http), comparable(deployed));
    assert.deepEqual(
      comparable(publicFrames(http)),
      comparable(publicFrames(deployed)),
    );
    const marker = http.at(-1);
    assert.equal(marker.type, "sync.completed");
    assert.equal(marker.cursor, current);
    assert.equal(marker.data.snapshot.cursor, current);
    assert.equal(marker.data.fromCursor, cursor);
    assert.equal(marker.data.mode, "replay");
    assert.deepEqual(marker.data.snapshot.state, {
      kind: "running",
      turnId: "turn",
    });
    assert.equal(marker.data.snapshot.pending.length, 1);
    assert.deepEqual(marker.data.snapshot.messages, []);
    if (cursor === current) {
      assert.equal(http.length, 1);
      const warm = advanceSourceSync(
        beginSourceSync(paired.state.pair),
        publicFrames(http),
      );
      assert.equal(warm.failure, null);
      assert.equal(warm.state.phase, "ready");
      assert.equal(warm.operational?.state.kind, "running");
      assert.equal(
        warm.operational?.pending[0].method,
        "item/tool/requestUserInput",
      );
      assert.equal(
        (warm.operational?.pending[0].detail.questions as any[])[0].id,
        "fixture",
      );
      assert.deepEqual(warm.state.pair?.entries, paired.state.pair?.entries);
    } else
      assert.equal(
        http.filter((event: any) => event.type === "message.delta")[0].data
          .delta,
        "😀answer",
      );
  }
  assert.deepEqual(
    envelopes,
    [initial, current].map((cursor) => ({
      method: "GET",
      path: "/threads/thread/events",
      cursor,
      window: true,
      sync: "v1",
    })),
  );
  await manager.resume("restored");
  runtime.emit("notification", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "restored",
      turnId: "restored-turn",
      itemId: "restored-item",
      delta: "suffix",
    },
  });
  const restoredHttp = parse(
    await untilMarker(
      await transport.request({
        owner: coreUrl,
        path: "/threads/restored/events",
        window: true,
        sync: "v1",
      }),
      "snapshot",
    ),
  );
  const restoredDeployed = parse(
    await untilMarker(
      await transport.request({
        owner,
        sessionId,
        path: "/threads/restored/events",
        window: true,
        sync: "v1",
      }),
      "snapshot",
    ),
  );
  assert.deepEqual(restoredHttp, restoredDeployed);
  assert.deepEqual(
    restoredHttp.map((event) => event.type),
    ["snapshot"],
  );
  assert.equal(restoredHttp[0].data.messages[0].text, "suffix");
  const uncovered = advanceSourceSync(
    beginSourceSync(null),
    publicFrames(restoredHttp),
  );
  assert.equal(uncovered.state.pair, null);
  assert.equal(uncovered.state.phase, "cold");
  // A post-HTTP handoff also cannot authorize this incomplete source baseline.
  const handoff = advanceSourceSync(
    beginSourceSync(null, true),
    publicFrames(restoredHttp),
  );
  assert.notEqual(handoff.failure, null);
  assert.equal(handoff.state.pair, null);
});
