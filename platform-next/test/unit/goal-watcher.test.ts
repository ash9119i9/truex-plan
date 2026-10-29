import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId } from "mongodb";
import type { AppConfig } from "../../src/config/app-config";
import type { DatabaseService } from "../../src/database/database.service";
import type { ChatsService } from "../../src/modules/chats/chats.service";
import type { RunExecutor } from "../../src/modules/chats/run-executor";
import type {
  ChatCursor,
  ChatEvent,
  RuntimeClient,
  RuntimeGoal,
} from "../../src/modules/chats/runtime-client";
import type { GoalStore } from "../../src/modules/goals/goal-store";
import { GoalWatcher } from "../../src/modules/goals/goal-watcher";
import type { TenantsService } from "../../src/modules/tenants/tenants.service";

const GOAL: RuntimeGoal = {
  objective: "Ship it.",
  status: "active",
  tokenBudget: 100_000,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1_800_000_000,
  updatedAt: 1_800_000_000,
};
const RUN_A = new ObjectId().toHexString();
const RUN_B = new ObjectId().toHexString();

// A watcher over a scripted chat stream and goal store. The stream yields
// `events`, then stays open until the reader stops.
function watcherOver(
  events: ChatEvent[],
  options: {
    begin?: (runId: string) => "started" | "exists" | "busy" | "unavailable";
    renew?: () => boolean;
  } = {},
) {
  const log: string[] = [];
  const chatId = new ObjectId();
  const client = {
    async *chatEvents(_ref: unknown, _cursor: unknown, signal: AbortSignal) {
      for (const event of events) yield event;
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    },
  } as unknown as RuntimeClient;
  const store = {
    claimWatch: async () => ({
      chatId,
      ownerId: new ObjectId(),
      goal: GOAL,
      origin: "user",
      watch: null,
    }),
    renewWatch: async () => options.renew?.() ?? true,
    saveCursor: async (
      _db: string,
      _chat: ObjectId,
      _o: string,
      at: ChatCursor,
    ) => {
      log.push(`cursor ${at.seq}`);
      return true;
    },
    releaseWatch: async () => {
      log.push("release");
    },
    recordUpdate: async () => ({ applied: true, goal: null }),
    // The browser chat stream's events (Task 12); none are read here.
    publish: () => undefined,
    repairSlots: async () => ({ released: 0, repaired: false }),
  } as unknown as GoalStore;
  const chats = {
    beginGoalRun: async (_t: unknown, _c: ObjectId, runId: ObjectId) => {
      const answer = options.begin?.(runId.toHexString()) ?? "started";
      log.push(`${runId.toHexString() === RUN_A ? "A" : "B"} ${answer}`);
      return answer;
    },
  } as unknown as ChatsService;
  // No thread yet, so a snapshot finds nothing in history to save.
  const database = {
    tenantDb: () => ({
      collection: () => ({
        findOne: async () => ({ runtime: { threadId: null } }),
      }),
    }),
  } as unknown as DatabaseService;
  const watcher = new GoalWatcher(
    { chat: { recoverySweepMs: 0 } } as unknown as AppConfig,
    database,
    client,
    chats,
    { configured: true } as unknown as RunExecutor,
    {} as TenantsService,
    store,
  );
  const tenant = { tenantId: new ObjectId(), dbName: "truex_next_t_test" };
  return { watcher, log, chatId, tenant };
}

const snapshot: ChatEvent = {
  seq: 1,
  type: "chat.snapshot",
  streamId: "s1",
  goal: GOAL,
  origin: "user",
  activeRun: null,
};
const started = (seq: number, runId: string): ChatEvent => ({
  seq,
  type: "run.started",
  runId,
  turnId: `turn-${seq}`,
  trigger: "goal",
});

async function until(what: string, check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}

describe("GoalWatcher", () => {
  test("a goal run that finds the chat busy is tried again before the next, and the cursor passes it only once it is saved", async () => {
    let busy = 2;
    const { watcher, log, chatId, tenant } = watcherOver(
      [snapshot, started(2, RUN_A), started(3, RUN_B)],
      {
        begin: (runId) => (runId === RUN_A && busy-- > 0 ? "busy" : "started"),
      },
    );
    try {
      assert.equal(await watcher.watch(tenant, chatId), true);
      await until("both runs were begun", () => log.includes("cursor 3"));
    } finally {
      await watcher.onApplicationShutdown();
    }
    assert.deepEqual(log, [
      "cursor 1",
      "A busy",
      "A busy",
      "A started",
      "cursor 2",
      "B started",
      "cursor 3",
      "release",
    ]);
  });

  test("a reader whose lease renewal fails stops at once, with no events, and gives back nothing", async () => {
    const { watcher, log, chatId, tenant } = watcherOver([snapshot], {
      renew: () => false,
    });
    watcher.renewMs = 20;
    try {
      assert.equal(await watcher.watch(tenant, chatId), true);
      await until(
        "the reader stopped",
        () => !watcher.isReading(tenant.dbName, chatId),
      );
    } finally {
      await watcher.onApplicationShutdown();
    }
    // Stopped by the lost lease, not by the shutdown: nothing given back.
    assert.deepEqual(log, ["cursor 1"]);
  });

  test("each sweep repairs every ready tenant's slot counts; a failed repair still lets that tenant's lapsed watches be looked at", async () => {
    const log: string[] = [];
    const tenants = [
      { _id: new ObjectId(), dbName: "truex_next_t_a" },
      { _id: new ObjectId(), dbName: "truex_next_t_b" },
    ];
    const store = {
      repairSlots: async (dbName: string, tenantId: ObjectId) => {
        log.push(`repair ${dbName} ${tenantId.toHexString()}`);
        if (dbName === "truex_next_t_a") throw new Error("database down");
        return { released: 0, repaired: false };
      },
      lapsedWatches: async (dbName: string) => {
        log.push(`lapsed ${dbName}`);
        return [];
      },
    } as unknown as GoalStore;
    const watcher = new GoalWatcher(
      { chat: { recoverySweepMs: 0 } } as unknown as AppConfig,
      {} as DatabaseService,
      {} as RuntimeClient,
      {} as ChatsService,
      { configured: true, isDraining: false } as unknown as RunExecutor,
      { listReady: async () => tenants } as unknown as TenantsService,
      store,
    );
    try {
      assert.equal(await watcher.runOnce(), 0);
    } finally {
      await watcher.onApplicationShutdown();
    }
    assert.deepEqual(log, [
      `repair truex_next_t_a ${tenants[0]!._id.toHexString()}`,
      "lapsed truex_next_t_a",
      `repair truex_next_t_b ${tenants[1]!._id.toHexString()}`,
      "lapsed truex_next_t_b",
    ]);
  });
});
