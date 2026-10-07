import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { publicEvent, publicSnapshot } from "../src/public";
import { orderConversation } from "../../shared/command-history";
import type { DomainEvent, Session } from "../../shared/contracts";

const visual = {
  id: "61d5405e-9a54-4b1c-a7bb-f22afde755b8",
  title: "Sales",
  description: "Sales chart",
  height: 420,
  turnId: "turn",
  callId: "call",
};
const event: DomainEvent = {
  type: "visual.published",
  seq: 1,
  cursor: "generation:1",
  at: "2026-10-07T00:00:00.000Z",
  threadId: "thread",
  turnId: visual.turnId,
  itemId: visual.callId,
  data: { visual },
};

test("public visual associations strip executable source and reject malformed or mismatched identities", () => {
  const projected = publicEvent({
    ...event,
    data: {
      visual: { ...visual, html: "PRIVATE_SOURCE", inputHash: "PRIVATE_HASH" },
    },
  });
  assert.deepEqual(projected.data, { visual });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  for (const invalid of [
    { ...visual, id: "bad" },
    { ...visual, height: Infinity },
    { ...visual, height: 901 },
    { ...visual, title: " " },
    { ...visual, turnId: "" },
  ]) {
    assert.equal(publicEvent({ ...event, data: { visual: invalid } }), null);
  }
  assert.equal(publicEvent({ ...event, turnId: "wrong" }), null);
  assert.deepEqual(
    publicSnapshot({
      visuals: [
        { ...visual, html: "PRIVATE_SOURCE" },
        { ...visual, id: "bad" },
      ],
    }).visuals,
    [visual],
  );
  for (const tool of ["html_render", "html_preview"]) {
    const activity = publicEvent({
      ...event,
      type: "item.completed",
      data: {
        item: {
          type: "dynamicToolCall",
          tool,
          arguments: { html: "PRIVATE_SOURCE" },
          contentItems: [
            { type: "inputImage", imageUrl: "PRIVATE_SCREENSHOT" },
          ],
          success: true,
        },
      },
    });
    assert.equal(activity.type, "activity.updated");
    assert.doesNotMatch(JSON.stringify(activity), /PRIVATE/);
  }
});

test(
  "Mongo visual ingestion survives failed acknowledgment, deduplicates replay and reconciles before prose",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "visual_test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const session: Session = {
      _id: "s",
      agentId: "assistant",
      threadId: "thread",
      agentCoreHost: "http://fixture.invalid",
      status: "active",
      cwd: "/tmp",
      createdAt: event.at,
    };
    await store.sessions.insertOne(session);
    await store.persist("s", {
      ...event,
      type: "message.final",
      seq: 2,
      itemId: "answer",
      data: { text: "Published the chart.", messageIndex: 0 },
    });
    const service = new PlatformService(store);
    let failAcknowledgment = true,
      acknowledgments = 0;
    t.mock.method(service, "owned", async (_session: Session, path: string) => {
      if (path === "/records") return [{ key: "record", event }];
      if (path === "/records/ack") {
        acknowledgments++;
        if (failAcknowledgment) {
          failAcknowledgment = false;
          throw new Error("Lost acknowledgment");
        }
        return { ok: true };
      }
      if (path.startsWith("/items"))
        return {
          data: [
            {
              turnId: "turn",
              item: {
                type: "userMessage",
                id: "user",
                content: [{ type: "text", text: "Chart please" }],
              },
            },
            {
              turnId: "turn",
              item: {
                type: "agentMessage",
                id: "answer",
                text: "Published the chart.",
              },
            },
          ],
          nextCursor: null,
        };
      throw new Error(`Unexpected fixture route ${path}`);
    });
    await assert.rejects(service.ingest(session), /Lost acknowledgment/);
    assert.equal(
      await store.messages.countDocuments({ visuals: { $exists: true } }),
      1,
    );
    await service.ingest(session);
    await service.ingest(session);
    await service.reconcile(session);
    assert.equal(acknowledgments, 3);
    const ordered = orderConversation(
      await store.messages.find({ sessionId: "s" }).toArray(),
    );
    assert.equal(ordered.length, 3);
    assert.equal(ordered[0].role, "user");
    assert.deepEqual(ordered[1].visuals, [visual]);
    assert.equal(ordered[2].text, "Published the chart.");
    await store.persist("s", event);
    assert.equal(
      await store.messages.countDocuments({ visuals: { $exists: true } }),
      1,
    );
    assert.equal(
      await store.messages.countDocuments({ sessionId: "other" }),
      0,
    );
    await store.messages.insertMany(
      Array.from({ length: 1000 }, (_, index) => ({
        _id: `capacity-${index}`,
        sessionId: "capacity",
        role: "assistant" as const,
        text: "Fixture",
        at: event.at,
      })),
    );
    await store.persist("capacity", event);
    const execution = await store.messages
      .find({ sessionId: "capacity", visuals: { $exists: true } })
      .explain("executionStats");
    assert.equal(execution.executionStats.nReturned, 1);
    assert.equal(
      execution.executionStats.totalDocsExamined,
      1,
      "Visual recovery uses its partial index rather than scanning a long transcript",
    );
  },
);
