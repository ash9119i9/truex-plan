import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Collection } from "mongodb";
import type { DomainEvent, Session } from "../../shared/contracts";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { AutomationStore } from "../src/automation/store";
import { AutomationExecution } from "../src/automation/execution";
import {
  ingestAutomationEvidence,
  markAutomationAuditFailure,
  repairAutomationAudit,
} from "../src/automation/evidence";

const recipe = {
  name: "Report",
  agentId: "agent",
  prompt: "restricted saved prompt",
  trigger: {
    kind: "interval",
    everyMs: 60000,
    anchorAt: "2026-10-09T00:00:00.000Z",
    timeZone: "UTC",
  },
};
test(
  "automation ingestion persists real evidence before acknowledgments, preserves incomplete audit, and reconciles exact roots",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(
      mongo.getUri(),
      "automation_ingestion",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const db = new AutomationStore(store);
    async function fixture() {
      const definition = await db.create("owner", recipe);
      await db.control(definition.id, "owner", 1, "enable");
      const run = await db.admit({
        automationId: definition.id,
        revision: 1,
        source: "manual",
        requestKey: "manual",
        workflowId: definition.id,
      });
      const session: Session = {
        _id: `session_${run.id}`,
        userId: "owner",
        agentId: "agent",
        threadId: `thread_${run.id}`,
        agentCoreHost: "http://localhost:4100",
        status: "active",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        automationPolicy: {
          automationId: definition.id,
          runId: run.id,
          revision: 1,
          promptRef: `${definition.id}:1`,
        },
      };
      await store.sessions.insertOne(session);
      await db.runs.updateOne(
        { _id: run.id },
        {
          $set: {
            sessionId: session._id,
            provisionState: "accepted",
            dispatchState: "claimed",
            stopState: "running",
          },
        },
      );
      const platform = new PlatformService(store);
      let queue: { key: string; event: DomainEvent }[] = [],
        next = 0;
      const acknowledgments: string[][] = [];
      let beforeAck: ((keys: string[]) => Promise<void>) | undefined;
      platform.owned = async (
        _session: any,
        path: string,
        _method?: string,
        body?: any,
      ) => {
        if (path === "/records") return [...queue];
        if (path === "/records/ack") {
          await beforeAck?.(body.keys);
          acknowledgments.push(body.keys);
          queue = queue.filter((record) => !body.keys.includes(record.key));
          return {};
        }
        return {};
      };
      function event(
        type: DomainEvent["type"],
        data: Record<string, any> = {},
        patch: Partial<DomainEvent> = {},
      ) {
        const seq = ++next;
        const event: DomainEvent = {
          type,
          threadId: session.threadId,
          turnId: "root",
          itemId: `item_${seq}`,
          seq,
          cursor: `generation:${seq}`,
          at: new Date().toISOString(),
          data: { automationPolicy: session.automationPolicy, ...data },
          ...patch,
        };
        const record = { key: `record_${seq}`, event };
        queue.push(record);
        return record;
      }
      return {
        run,
        session,
        platform,
        event,
        acknowledgments,
        execution: new AutomationExecution(db, platform),
        get queue() {
          return queue;
        },
        set beforeAck(fn: ((keys: string[]) => Promise<void>) | undefined) {
          beforeAck = fn;
        },
      };
    }
    await t.test(
      "restricted result and sanitized ledger exist before ACK; replay is idempotent",
      async () => {
        const f = await fixture();
        const result = f.event("message.final", {
          text: "restricted output password=private",
          messageIndex: 0,
        });
        f.event("automation.tool", {
          tool: "list_accounts",
          phase: "completed",
          status: "completed",
          effects: "unverified",
          arguments: { token: "private-token" },
          result: { text: "raw private payload" },
        });
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "root", status: "completed" },
        });
        f.beforeAck = async (keys) => {
          assert.equal(keys.length, 3);
          assert.equal(
            await db.ledger.countDocuments({
              runId: f.run.id,
              type: {
                $in: ["message.final", "automation.tool", "turn.completed"],
              },
            }),
            3,
          );
          const persisted = await store.messages.findOne({
            _id: `${f.session._id}:assistant:root:0`,
          });
          assert.equal(persisted?.text, result.event.data.text);
          const run = await db.run(f.run.id);
          assert.equal(run?.resultSeen, true);
          assert.equal(run?.runtimeTerminal, "completed");
        };
        const replay = [...f.queue];
        await f.platform.ingest(f.session);
        const sanitized = JSON.stringify(
          await db.events(f.run.automationId, "owner", f.run.id),
        );
        for (const restricted of [
          "private-token",
          "raw private payload",
          "password=private",
          "restricted saved prompt",
        ])
          assert.equal(sanitized.includes(restricted), false);
        const originalOwned = f.platform.owned;
        f.platform.owned = async (
          s: any,
          path: string,
          method?: string,
          body?: any,
        ) =>
          path === "/records" ? replay : originalOwned(s, path, method, body);
        await f.platform.ingest(f.session);
        assert.equal(
          await store.messages.countDocuments({ sessionId: f.session._id }),
          1,
        );
        assert.equal(
          await db.ledger.countDocuments({
            runId: f.run.id,
            type: "automation.tool",
          }),
          1,
        );
        f.platform.owned = originalOwned;
        assert.equal((await f.execution.observe(f.run.id)).terminal, true);
        assert.equal((await db.run(f.run.id))?.outcome, "succeeded");
      },
    );
    await t.test(
      "ledger failure retains all records and marks incomplete without acknowledging partial persistence",
      async () => {
        const f = await fixture();
        f.event("message.final", { text: "private result", messageIndex: 0 });
        f.event("automation.tool", {
          tool: "crm_write",
          phase: "completed",
          effects: "unverified",
        });
        const original = AutomationStore.prototype.append;
        AutomationStore.prototype.append = async function (input, session) {
          if (input.runId === f.run.id && input.type === "automation.tool")
            throw new Error("ledger unavailable");
          return original.call(this, input, session);
        };
        try {
          await assert.rejects(
            f.platform.ingest(f.session),
            /ledger unavailable/,
          );
        } finally {
          AutomationStore.prototype.append = original;
        }
        assert.equal(f.acknowledgments.length, 0);
        assert.equal(f.queue.length, 2);
        assert.equal((await db.run(f.run.id))?.auditComplete, false);
        assert.equal(
          await store.messages.countDocuments({ sessionId: f.session._id }),
          1,
        );
        await f.platform.ingest(f.session);
        assert.equal(f.queue.length, 0);
        assert.equal(
          await db.ledger.countDocuments({
            runId: f.run.id,
            type: "message.final",
          }),
          1,
        );
        assert.equal(
          await db.ledger.countDocuments({
            runId: f.run.id,
            type: "automation.tool",
          }),
          1,
        );
      },
    );
    await t.test(
      "conflicting replay preserves the original cursor projection and ledger",
      async () => {
        const f = await fixture();
        const original = f.event("automation.blocked", {
          reason: "approval_required",
          actor: "unattended-policy",
        });
        await ingestAutomationEvidence(db, f.session, original.event);
        await ingestAutomationEvidence(db, f.session, {
          ...original.event,
          data: { ...original.event.data, reason: "delegation_prohibited" },
        });
        const run = await db.run(f.run.id);
        assert.equal(run?.blocker, "approval_required");
        assert.equal(run?.helperEscaped, undefined);
        const ledger = await db.ledger.findOne({
          id: `${f.run.id}:runtime:${original.event.cursor}`,
        });
        assert.equal(ledger?.detail?.reason, "approval_required");
      },
    );
    await t.test(
      "conflicting final replay preserves automation output, reference and ledger while interactive output updates",
      async () => {
        const f = await fixture();
        const original = f.event("message.final", {
          text: "original restricted output",
          messageIndex: 0,
        });
        await f.platform.ingest(f.session);
        const reference = (await db.run(f.run.id))?.resultRef;
        const ledger = await db.ledger.findOne({
          id: `${f.run.id}:runtime:${original.event.cursor}`,
        });
        f.event(
          "message.final",
          { text: "conflicting replay output", messageIndex: 0 },
          {
            cursor: original.event.cursor,
            itemId: original.event.itemId,
          },
        );
        await f.platform.ingest(f.session);
        assert.equal(
          (await store.messages.findOne({ _id: reference!.id }))?.text,
          "original restricted output",
        );
        assert.deepEqual((await db.run(f.run.id))?.resultRef, reference);
        assert.deepEqual(await db.ledger.findOne({ _id: ledger!._id }), ledger);
        assert.equal(
          await db.ledger.countDocuments({
            runId: f.run.id,
            type: "message.final",
          }),
          1,
        );

        const interactive: Session = {
          ...f.session,
          _id: `${f.session._id}_interactive`,
        };
        delete interactive.automationPolicy;
        await store.sessions.insertOne(interactive);
        await store.persist(interactive._id, original.event);
        await store.persist(interactive._id, {
          ...original.event,
          data: { ...original.event.data, text: "updated interactive output" },
        });
        assert.equal(
          (
            await store.messages.findOne({
              _id: `${interactive._id}:assistant:root:0`,
            })
          )?.text,
          "updated interactive output",
        );
      },
    );
    await t.test(
      "helper messages cannot supply root results and synthetic failure retains the execution fence",
      async () => {
        const f = await fixture();
        f.event(
          "message.final",
          { text: "helper success", messageIndex: 0 },
          { threadId: "helper-thread", turnId: "helper-turn" },
        );
        f.event(
          "turn.completed",
          {
            terminationEvidence: "runtime",
            turn: { id: "helper-turn", status: "completed" },
          },
          { threadId: "helper-thread", turnId: "helper-turn" },
        );
        f.event("turn.completed", {
          terminationEvidence: "unconfirmed",
          turn: { id: "root", status: "failed", code: "TURN_STALLED" },
        });
        await f.platform.ingest(f.session);
        assert.equal((await db.run(f.run.id))?.resultSeen, undefined);
        assert.equal((await db.run(f.run.id))?.runtimeTerminal, undefined);
        assert.equal(
          (await db.get(f.run.automationId, "owner"))?.activeRunId,
          f.run.id,
        );
        assert.equal((await f.execution.observe(f.run.id)).terminal, false);
        f.event("message.final", { text: "real root result", messageIndex: 1 });
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "root", status: "completed" },
        });
        await f.execution.observe(f.run.id);
        assert.equal((await db.run(f.run.id))?.outcome, "succeeded");
        assert.equal(
          (await db.get(f.run.automationId, "owner"))?.activeRunId,
          undefined,
        );
      },
    );
    await t.test(
      "runtime audit-incomplete evidence survives ingestion and cannot be classified as success",
      async () => {
        const f = await fixture();
        f.event("message.final", {
          text: "result exists",
          messageIndex: 0,
          auditIncomplete: true,
        });
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "root", status: "completed" },
          auditIncomplete: true,
        });
        await f.execution.observe(f.run.id);
        const run = await db.run(f.run.id);
        assert.equal(run?.auditComplete, false);
        assert.equal(run?.auditLost, true);
        assert.equal(
          (await db.get(f.run.automationId, "owner"))?.auditBlocked,
          true,
        );
        assert.equal(run?.outcome, "failed");
        assert.equal(run?.reason, "audit_incomplete");
      },
    );
    await t.test(
      "blocker ledger retains policy actor, denied method, decision and stop evidence without private request text",
      async () => {
        const f = await fixture();
        f.event("automation.blocked", {
          reason: "approval_required",
          method: "item/permissions/requestApproval",
          actor: "unattended-policy",
          decision: "denied",
          termination: "requested",
          questions: [{ question: "private decision context" }],
        });
        await f.platform.ingest(f.session);
        const blocker = await db.ledger.findOne({
          runId: f.run.id,
          type: "automation.blocked",
        });
        assert.equal(blocker?.detail?.actor, "unattended-policy");
        assert.equal(
          blocker?.detail?.method,
          "item/permissions/requestApproval",
        );
        assert.equal(blocker?.detail?.status, "denied");
        assert.equal(blocker?.detail?.stopState, "requested");
        assert.equal(
          JSON.stringify(blocker).includes("private decision context"),
          false,
        );
      },
    );
    await t.test(
      "transaction rollback never acknowledges a ledger without its run projection",
      async () => {
        const f = await fixture();
        f.event("message.final", {
          text: "restricted transactional result",
          messageIndex: 0,
        });
        const original = AutomationStore.prototype.transaction;
        let injected = false;
        AutomationStore.prototype.transaction = async function (work) {
          return original.call(this, async (session) => {
            const result = await work(session);
            if (!injected) {
              injected = true;
              throw new Error("projection transaction aborted");
            }
            return result;
          });
        };
        try {
          await assert.rejects(
            f.platform.ingest(f.session),
            /projection transaction aborted/,
          );
        } finally {
          AutomationStore.prototype.transaction = original;
        }
        assert.equal(f.acknowledgments.length, 0);
        assert.equal(
          await db.ledger.countDocuments({
            runId: f.run.id,
            type: "message.final",
          }),
          0,
        );
        assert.equal((await db.run(f.run.id))?.resultSeen, undefined);
        assert.equal((await db.run(f.run.id))?.auditComplete, false);
        await f.platform.ingest(f.session);
        assert.equal(
          await db.ledger.countDocuments({
            runId: f.run.id,
            type: "message.final",
          }),
          1,
        );
        assert.equal((await db.run(f.run.id))?.resultSeen, true);
      },
    );
    await t.test(
      "early native completion waits for delayed exact-root output and preserves terminal status",
      async () => {
        const f = await fixture();
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "root", status: "completed" },
        });
        assert.equal((await f.execution.observe(f.run.id)).terminal, false);
        assert.equal((await db.run(f.run.id))?.outcome, undefined);
        f.event(
          "message.final",
          { text: "helper cannot fill result", messageIndex: 0 },
          { threadId: "helper-thread", turnId: "helper" },
        );
        assert.equal((await f.execution.observe(f.run.id)).terminal, false);
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "root", status: "failed" },
        });
        f.event("message.final", { text: "late root output", messageIndex: 1 });
        assert.equal((await f.execution.observe(f.run.id)).terminal, true);
        assert.equal((await db.run(f.run.id))?.outcome, "succeeded");
        assert.equal((await db.run(f.run.id))?.runtimeTerminal, "completed");
      },
    );
    await t.test(
      "native termination must match both reviewed policy and exact root identity",
      async () => {
        const f = await fixture();
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "different-root", status: "completed" },
        });
        await f.platform.ingest(f.session);
        assert.equal((await db.run(f.run.id))?.runtimeTerminal, undefined);
        f.event("turn.completed", {
          automationPolicy: {
            ...f.session.automationPolicy,
            promptRef: "unreviewed-revision",
          },
          terminationEvidence: "runtime",
          turn: { id: "root", status: "completed" },
        });
        await f.platform.ingest(f.session);
        assert.equal((await db.run(f.run.id))?.runtimeTerminal, undefined);
        f.event("turn.completed", {
          terminationEvidence: "runtime",
          turn: { id: "root", status: "inProgress" },
        });
        await f.platform.ingest(f.session);
        assert.equal((await db.run(f.run.id))?.runtimeTerminal, undefined);
      },
    );
    await t.test(
      "two ingesters cannot bind differing early root turns to one run",
      async () => {
        const f = await fixture();
        const first = f.event(
          "message.final",
          { text: "first candidate root", messageIndex: 0 },
          { turnId: "candidate_a" },
        );
        const second = f.event(
          "message.final",
          { text: "second candidate root", messageIndex: 0 },
          { turnId: "candidate_b" },
        );
        let fetched = 0;
        const originalOwned = f.platform.owned;
        f.platform.owned = async (
          s: any,
          path: string,
          method?: string,
          body?: any,
        ) =>
          path === "/records"
            ? [fetched++ === 0 ? first : second]
            : originalOwned(s, path, method, body);
        let arrivals = 0,
          release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const original = AutomationStore.prototype.transaction;
        AutomationStore.prototype.transaction = async function (work) {
          if (++arrivals === 2) release();
          await gate;
          return original.call(this, work);
        };
        try {
          await Promise.all([
            f.platform.ingest(f.session),
            f.platform.ingest(f.session),
          ]);
        } finally {
          AutomationStore.prototype.transaction = original;
          f.platform.owned = originalOwned;
        }
        const evidence = await db.ledger
          .find({ runId: f.run.id, type: "message.final" })
          .toArray();
        assert.equal(evidence.length, 1);
        assert.equal(
          evidence[0].detail?.turnId,
          (await db.run(f.run.id))?.turnId,
        );
      },
    );
    await t.test(
      "audit repair cannot clear a concurrent permanent audit-loss dispatch block",
      async () => {
        const f = await fixture();
        await markAutomationAuditFailure(db, f.session);
        let readStarted!: () => void, resumeRead!: () => void;
        const started = new Promise<void>((resolve) => {
          readStarted = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          resumeRead = resolve;
        });
        const prototype = Collection.prototype as any,
          original = prototype.findOne;
        let pause = true;
        prototype.findOne = async function (filter: any, options: any) {
          const value = await original.call(this, filter, options);
          if (
            pause &&
            this.collectionName === "automation_runs" &&
            filter?._id === f.run.id &&
            options?.session
          ) {
            pause = false;
            readStarted();
            await resume;
          }
          return value;
        };
        const repair = repairAutomationAudit(db, f.session);
        try {
          await started;
          const loss = f.event("automation.tool", {
            tool: "crm_write",
            phase: "completed",
            auditIncomplete: true,
          });
          await ingestAutomationEvidence(db, f.session, loss.event);
          resumeRead();
          assert.equal(await repair, false);
        } finally {
          resumeRead();
          prototype.findOne = original;
        }
        assert.equal((await db.run(f.run.id))?.auditLost, true);
        assert.equal((await db.run(f.run.id))?.auditComplete, false);
        assert.equal(
          (await db.get(f.run.automationId, "owner"))?.auditBlocked,
          true,
        );
      },
    );
    await t.test(
      "repairing one transient audit does not clear another run's permanent audit block",
      async () => {
        const f = await fixture();
        await markAutomationAuditFailure(db, f.session);
        await db.runs.insertOne({
          ...f.run,
          _id: `older_${f.run.id}`,
          id: `older_${f.run.id}`,
          requestKey: "older-manual",
          auditLost: true,
          auditComplete: false,
          status: "failed",
          outcome: "failed",
          stopState: "stopped",
        });
        assert.equal(await repairAutomationAudit(db, f.session), true);
        assert.equal((await db.run(f.run.id))?.auditComplete, true);
        assert.equal(
          (await db.get(f.run.automationId, "owner"))?.auditBlocked,
          true,
        );
      },
    );
  },
);
