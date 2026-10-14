import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/persistence/store";
import { PlatformService } from "../src/app/platform-service";
import { asUser, ashok, insertFixtures } from "./fixtures";
import type { ApprovalModesConfig } from "../../shared/contracts";

const flags: ApprovalModesConfig = {
  enabled: true,
  defaultMode: "ask",
  autopilot: false,
  nameHeuristic: true,
};

test("a persisted desired mode must be confirmed after reload before accepting a message", async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "resume_approval").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await insertFixtures(store);
  const original = new PlatformService(
    store,
    ["http://fixture.invalid"],
    flags,
  );
  original.call = async (_host, _path, _method, body) => ({
    threadId: "thread",
    approvalMode: body.approvalMode,
  });
  const created = await asUser(ashok, () => original.create("assistant"));
  original.call = async () => {
    throw new Error("Live mode update lost its acknowledgment");
  };
  await assert.rejects(
    asUser(ashok, () => original.setApprovalMode(created._id, "readOnly")),
    /lost its acknowledgment/,
  );
  assert.equal(
    (await store.sessions.findOne({ _id: created._id }))?.approvalMode,
    "readOnly",
  );

  for (const [index, resumeAck, legacyAck] of [
    [0, { approvalMode: "ask" }, { mode: "readOnly" }],
    [1, {}, undefined],
    [2, {}, { mode: "ask" }],
    [3, {}, {}],
  ] as const) {
    await t.test(
      `unconfirmed resume ${index} is rejected before every durable/turn side effect`,
      async () => {
        const restarted = new PlatformService(
          store,
          ["http://fixture.invalid"],
          flags,
        );
        const calls: string[] = [];
        restarted.call = async (_host, path, _method, body) => {
          calls.push(path);
          if (path.endsWith("/resume")) {
            assert.equal(body.approvalMode, "readOnly");
            return resumeAck;
          }
          if (path.endsWith("/approval-mode")) {
            assert.equal(body.mode, "readOnly");
            return legacyAck;
          }
          if (path.endsWith("/turns")) return { turnId: "unsafe-turn" };
          throw new Error(`Unexpected runtime side effect: ${path}`);
        };
        const before = await store.sessions.findOne({ _id: created._id });
        await assert.rejects(
          asUser(ashok, () =>
            restarted.message(
              created._id,
              "Synthetic reload question",
              `blocked-${index}`,
            ),
          ),
          { status: 502, code: "APPROVAL_MODE_UNCONFIRMED" },
        );
        assert.equal(
          await store.messages.countDocuments({ sessionId: created._id }),
          0,
        );
        assert.deepEqual(
          await store.sessions.findOne({ _id: created._id }),
          before,
        );
        assert.deepEqual(
          calls,
          resumeAck.approvalMode === undefined
            ? ["/threads/thread/resume", "/threads/thread/approval-mode"]
            : ["/threads/thread/resume"],
        );
      },
    );
  }

  for (const legacy of [false, true]) {
    await t.test(
      `confirmed ${legacy ? "legacy" : "current"} resume accepts exactly one turn`,
      async () => {
        const restarted = new PlatformService(
          store,
          ["http://fixture.invalid"],
          flags,
        );
        const calls: string[] = [];
        restarted.call = async (_host, path, _method, body) => {
          calls.push(path);
          if (path.endsWith("/resume"))
            return legacy ? {} : { approvalMode: body.approvalMode };
          if (path.endsWith("/approval-mode")) return { mode: body.mode };
          if (path.endsWith("/turns")) return { turnId: `turn-${legacy}` };
          throw new Error(`Unexpected request: ${path}`);
        };
        await asUser(ashok, () =>
          restarted.message(
            created._id,
            "Synthetic confirmed question",
            `confirmed-${legacy}`,
          ),
        );
        assert.deepEqual(
          calls,
          legacy
            ? [
                "/threads/thread/resume",
                "/threads/thread/approval-mode",
                "/threads/thread/turns",
              ]
            : ["/threads/thread/resume", "/threads/thread/turns"],
        );
      },
    );
  }
  await t.test("feature-off resume retains its old wire contract", async () => {
    const restarted = new PlatformService(store, ["http://fixture.invalid"], {
      ...flags,
      enabled: false,
    });
    const calls: string[] = [];
    restarted.call = async (_host, path, _method, body) => {
      calls.push(path);
      if (path.endsWith("/resume")) {
        assert.equal("approvalMode" in body, false);
        return {};
      }
      if (path.endsWith("/turns")) return { turnId: "feature-off-turn" };
      throw new Error(`Unexpected request: ${path}`);
    };
    await asUser(ashok, () =>
      restarted.message(
        created._id,
        "Synthetic feature-off question",
        "feature-off",
      ),
    );
    assert.deepEqual(calls, [
      "/threads/thread/resume",
      "/threads/thread/turns",
    ]);
  });
});
