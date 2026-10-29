import { Inject, Injectable, Logger } from "@nestjs/common";
import { ObjectId, type Collection, type Filter } from "mongodb";
import { DatabaseService } from "../../database/database.service";
import {
  CHATS_COLLECTION,
  type ChatDoc,
  type ChatGoalSummary,
} from "../chats/chat";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import type {
  ChatCursor,
  GoalOrigin,
  RuntimeGoal,
} from "../chats/runtime-client";
import {
  GOAL_HISTORY_LIMIT,
  GOAL_SLOT_REPAIR_QUIET_MS,
  GOAL_SLOTS_COLLECTION,
  GOAL_SLOTS_PER_USER,
  GOAL_WATCH_LEASE_MS,
  GOALS_COLLECTION,
  type GoalDoc,
  type GoalHistoryEntry,
  type GoalPosition,
  type GoalReview,
  type GoalSlotsDoc,
  type GoalWatch,
} from "./goal";

// A goal update as the adapter reported it, on the chat stream (position)
// or in a direct answer (position null).
export interface GoalUpdateInput {
  readonly goal: RuntimeGoal;
  readonly origin: GoalOrigin;
  readonly position: GoalPosition | null;
}

// What changed in a chat's goal, for the browser chat stream
// (GET /chats/:id/events). In-process only: a browser sees the events of
// the process it is connected to, as for reply streams.
export type GoalEvent =
  | { readonly type: "goal.updated"; readonly goal: GoalDoc }
  | { readonly type: "goal.cleared" }
  | {
      readonly type: "run.started";
      readonly runId: string;
      readonly turnId: string;
    };

// Writes to one chat's goal document that lose a compare-and-set are re-read
// and decided again this many times. A chat has few writers (its watcher and
// direct answers), so running out means something is wrong.
const MAX_UPDATE_ATTEMPTS = 5;

// Whether `update` is newer than the saved goal. Codex reports a goal's
// createdAt and updatedAt in whole seconds: a later createdAt is a new goal,
// then a later updatedAt is a later state of the same goal. Within one second
// only the chat stream orders updates, so an update at or before the saved
// position on the same stream is a replay. Across streams (an adapter
// restart) or for direct answers nothing orders a same-second update; it is
// applied, and the stream's next update for that goal corrects it if it was
// older.
function supersedes(saved: GoalDoc, update: GoalUpdateInput): boolean {
  if (saved.ended) return false;
  const was = saved.goal;
  const now = update.goal;
  if (now.createdAt !== was.createdAt) return now.createdAt > was.createdAt;
  if (now.updatedAt !== was.updatedAt) return now.updatedAt > was.updatedAt;
  const at = saved.position;
  const next = update.position;
  if (at && next && at.streamId === next.streamId) return next.seq > at.seq;
  return true;
}

// The review a goal has after an update: a goal Codex has just marked
// complete awaits the owner's review, a new goal has none, and otherwise the
// saved review stands. `saved` is null for a new goal.
function reviewAfter(saved: GoalDoc | null, goal: RuntimeGoal): GoalReview {
  if (goal.status === "complete")
    return saved?.goal.status === "complete" ? saved.review : "pending";
  return saved?.review ?? "none";
}

// What changed from the saved goal (ported from the legacy goal-state).
function goalChanges(
  saved: RuntimeGoal | null,
  goal: RuntimeGoal,
  at: Date,
): GoalHistoryEntry[] {
  const entry = (kind: GoalHistoryEntry["kind"]): GoalHistoryEntry => ({
    at,
    kind,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
  });
  if (!saved || saved.createdAt !== goal.createdAt) return [entry("set")];
  const changes: GoalHistoryEntry[] = [];
  if (saved.objective !== goal.objective) changes.push(entry("objective"));
  if (saved.tokenBudget !== goal.tokenBudget) changes.push(entry("budget"));
  if (saved.status !== goal.status) changes.push(entry("status"));
  return changes;
}

// The goals collection and the per-tenant goal_slots counts. Slot counts
// change without a transaction: each step is one atomic write, ordered so
// that a crash between steps leaves a goal counted rather than uncounted
// (while unsure, a goal counts as active), and the goal sweep's repairSlots
// gives the extra count back.
// An excess of slot counts over marked goals, as repairSlots last saw it.
interface SlotExcess {
  readonly writes: number;
  readonly excess: Record<string, number>;
  readonly at: number;
}

@Injectable()
export class GoalStore {
  private readonly logger = new Logger("Goals");
  private readonly listeners = new Map<
    string,
    Set<(event: GoalEvent) => void>
  >();
  // repairSlots: each tenant's last excess seen, by `dbName:tenantId`.
  private readonly excessSeen = new Map<string, SlotExcess>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  // Calls `listener` with the chat's goal events written in this process
  // from now on. Returns the unsubscribe.
  subscribe(
    dbName: string,
    chatId: ObjectId,
    listener: (event: GoalEvent) => void,
  ): () => void {
    const key = `${dbName}:${chatId.toHexString()}`;
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set)
        this.listeners.delete(key);
    };
  }

  // Never throws into the write that published it.
  publish(dbName: string, chatId: ObjectId, event: GoalEvent): void {
    const set = this.listeners.get(`${dbName}:${chatId.toHexString()}`);
    for (const listener of set ?? [])
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({
          message: "goal event listener failed",
          error: error instanceof Error ? error.name : "unknown",
        });
      }
  }

  private goals(dbName: string): Collection<GoalDoc> {
    return this.database.tenantDb(dbName).collection<GoalDoc>(GOALS_COLLECTION);
  }

  private slots(dbName: string): Collection<GoalSlotsDoc> {
    return this.database
      .tenantDb(dbName)
      .collection<GoalSlotsDoc>(GOAL_SLOTS_COLLECTION);
  }

  // Saves a Codex goal update unless the saved one is newer (supersedes) or
  // goal mode ended in the chat. `before` is the document the decision was
  // made against, null when this update created it.
  async applyUpdate(
    dbName: string,
    chat: { chatId: ObjectId; ownerId: ObjectId },
    update: GoalUpdateInput,
  ): Promise<{ applied: boolean; before: GoalDoc | null }> {
    const goals = this.goals(dbName);
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const saved = await goals.findOne({ chatId: chat.chatId });
      const now = new Date();
      if (!saved) {
        try {
          await goals.insertOne({
            _id: new ObjectId(),
            chatId: chat.chatId,
            ownerId: chat.ownerId,
            goal: update.goal,
            origin: update.origin,
            review: reviewAfter(null, update.goal),
            slotHeld: false,
            ended: false,
            position: update.position,
            history: goalChanges(null, update.goal, now),
            watch: null,
            rev: 0,
            createdAt: now,
            updatedAt: now,
          });
          return { applied: true, before: null };
        } catch (error) {
          // Another writer created it first: decide against theirs.
          if (isDuplicateKeyError(error)) continue;
          throw error;
        }
      }
      if (!supersedes(saved, update)) return { applied: false, before: saved };
      const newGoal = update.goal.createdAt !== saved.goal.createdAt;
      const history = [
        ...saved.history,
        ...goalChanges(saved.goal, update.goal, now),
      ].slice(-GOAL_HISTORY_LIMIT);
      // Plain $set values are stored as written, so an objective such as
      // "$history" is never read as a field path.
      const written = await goals.updateOne(
        { _id: saved._id, rev: saved.rev, ended: false },
        {
          $set: {
            goal: update.goal,
            origin: update.origin,
            position: update.position ?? saved.position,
            history,
            rev: saved.rev + 1,
            updatedAt: now,
            // A new goal has not been reviewed; a completion awaits review.
            review: reviewAfter(newGoal ? null : saved, update.goal),
          },
        },
      );
      if (written.matchedCount === 1) return { applied: true, before: saved };
    }
    throw new Error(
      `Goal update for chat ${chat.chatId.toHexString()} kept conflicting; retry it.`,
    );
  }

  // Takes one of the tenant's and the owner's active-goal slots for the
  // chat's goal. True when the goal holds a slot afterwards, including when
  // it already did; false when a cap is reached or there is no goal to hold
  // one. The count is taken first and the goal marked second, so a crash in
  // between over-counts (repaired by repairSlots) rather than lets a goal
  // run uncounted.
  async claimSlot(
    dbName: string,
    tenantId: ObjectId,
    chatId: ObjectId,
    tenantCap: number,
  ): Promise<boolean> {
    const goals = this.goals(dbName);
    const goal = await goals.findOne(
      { chatId },
      { projection: { ownerId: 1, slotHeld: 1, ended: 1 } },
    );
    if (!goal || goal.ended) return false;
    if (goal.slotHeld) return true;
    const owner = goal.ownerId.toHexString();
    if (!(await this.take(dbName, tenantId, owner, tenantCap))) return false;
    const marked = await goals.updateOne(
      { chatId, slotHeld: false, ended: false },
      { $set: { slotHeld: true, updatedAt: new Date() } },
    );
    if (marked.modifiedCount === 1) return true;
    // A concurrent claim marked it first, or goal mode ended: give the count
    // back and report what the goal holds now.
    await this.give(dbName, tenantId, owner);
    const now = await goals.findOne(
      { chatId },
      { projection: { slotHeld: 1 } },
    );
    return now?.slotHeld === true;
  }

  // Takes one of the tenant's and the owner's slots before a goal is made
  // active (the goal API), so the adapter is never asked past a cap. The
  // goal is marked as holding it afterwards (adoptSlot), or it is given
  // back (giveSlot).
  takeSlot(
    dbName: string,
    tenantId: ObjectId,
    ownerId: ObjectId,
    tenantCap: number,
  ): Promise<boolean> {
    return this.take(dbName, tenantId, ownerId.toHexString(), tenantCap);
  }

  giveSlot(
    dbName: string,
    tenantId: ObjectId,
    ownerId: ObjectId,
  ): Promise<void> {
    return this.give(dbName, tenantId, ownerId.toHexString());
  }

  // Marks the chat's goal as holding the slot takeSlot took. Only while the
  // goal is still active: a goal that ended meanwhile, or one already
  // holding a slot, gets the count back instead.
  async adoptSlot(
    dbName: string,
    tenantId: ObjectId,
    chatId: ObjectId,
    ownerId: ObjectId,
  ): Promise<boolean> {
    const marked = await this.goals(dbName).updateOne(
      { chatId, slotHeld: false, ended: false, "goal.status": "active" },
      { $set: { slotHeld: true, updatedAt: new Date() } },
    );
    if (marked.modifiedCount === 1) return true;
    await this.giveSlot(dbName, tenantId, ownerId);
    return false;
  }

  // The owner's active goals counted in the tenant.
  async userSlots(
    dbName: string,
    tenantId: ObjectId,
    ownerId: ObjectId,
  ): Promise<number> {
    const slots = await this.slots(dbName).findOne({ _id: tenantId });
    return slots?.users[ownerId.toHexString()] ?? 0;
  }

  // The owner's review decision, in one write: only while the goal still
  // matches `where` (so of two decisions one wins), it sets `review` and
  // appends `kind` to the history, then rewrites the chat's summary.
  // Returns the goal as written, or null when it no longer matched.
  async decide(
    dbName: string,
    chatId: ObjectId,
    change: {
      where: Filter<GoalDoc>;
      review?: GoalReview;
      kind?: GoalHistoryEntry["kind"];
    },
  ): Promise<GoalDoc | null> {
    const goals = this.goals(dbName);
    // A write that loses to another (the watcher recording an update) is
    // decided again against what that one wrote.
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const saved = await goals.findOne({
        chatId,
        ended: false,
        ...change.where,
      });
      if (!saved) return null;
      const now = new Date();
      const entry: GoalHistoryEntry[] = change.kind
        ? [
            {
              at: now,
              kind: change.kind,
              objective: saved.goal.objective,
              status: saved.goal.status,
              tokenBudget: saved.goal.tokenBudget,
              tokensUsed: saved.goal.tokensUsed,
            },
          ]
        : [];
      const written = await goals.findOneAndUpdate(
        { _id: saved._id, rev: saved.rev, ended: false },
        {
          $set: {
            ...(change.review ? { review: change.review } : {}),
            history: [...saved.history, ...entry].slice(-GOAL_HISTORY_LIMIT),
            rev: saved.rev + 1,
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
      if (written) {
        await this.writeSummary(dbName, written);
        this.publish(dbName, chatId, { type: "goal.updated", goal: written });
        return written;
      }
    }
    throw new Error(
      `Goal decision for chat ${chatId.toHexString()} kept conflicting; retry it.`,
    );
  }

  // Ends goal mode in the chat (the member cleared it): no later update is
  // applied, its slot is given back and the chat's badge removed.
  async endGoal(
    dbName: string,
    tenantId: ObjectId,
    chatId: ObjectId,
  ): Promise<void> {
    await this.goals(dbName).updateOne(
      { chatId, ended: false },
      { $set: { ended: true, updatedAt: new Date() }, $inc: { rev: 1 } },
    );
    await this.releaseWhere(dbName, tenantId, { chatId });
    await this.database
      .tenantDb(dbName)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .updateOne({ _id: chatId }, { $unset: { goal: "" } });
    this.publish(dbName, chatId, { type: "goal.cleared" });
  }

  // Gives the chat's goal's slot back. True for the one call that made the
  // slotHeld true → false transition; any repeat or a goal without a slot is
  // false and changes no count.
  releaseSlot(
    dbName: string,
    tenantId: ObjectId,
    chatId: ObjectId,
  ): Promise<boolean> {
    return this.releaseWhere(dbName, tenantId, { chatId });
  }

  // releaseSlot for a goal that also matches `filter`.
  private async releaseWhere(
    dbName: string,
    tenantId: ObjectId,
    filter: Filter<GoalDoc>,
  ): Promise<boolean> {
    const released = await this.goals(dbName).findOneAndUpdate(
      { ...filter, slotHeld: true },
      { $set: { slotHeld: false, updatedAt: new Date() } },
      { projection: { ownerId: 1 } },
    );
    if (!released) return false;
    await this.give(dbName, tenantId, released.ownerId.toHexString());
    return true;
  }

  // The goal sweep's slot repair, for one tenant. First, gives back the
  // slot of each goal that holds one but ended or is no longer active (a
  // crash between saving that and releasing). Then, for a member counted
  // above the goals marked as holding a slot (a crash between taking a slot
  // and marking the goal, or between unmarking and giving it back), lowers
  // the count only when the same excess was seen at least
  // GOAL_SLOT_REPAIR_QUIET_MS earlier with no slot taken or given since: a
  // start waiting on Codex or a release in flight takes or gives within that
  // time, which changes `writes`. The lowering is applied only to the
  // `writes` it read, so of two processes sweeping, one repairs.
  async repairSlots(
    dbName: string,
    tenantId: ObjectId,
    now: number = Date.now(),
  ): Promise<{ released: number; repaired: boolean }> {
    let released = 0;
    while (
      await this.releaseWhere(dbName, tenantId, {
        $or: [{ ended: true }, { "goal.status": { $ne: "active" } }],
      })
    )
      released++;

    const key = `${dbName}:${tenantId.toHexString()}`;
    // The counts before the marks: a claim between the two reads then shows
    // as less excess, never more.
    const counts = await this.slots(dbName).findOne({ _id: tenantId });
    const marked = await this.goals(dbName)
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { slotHeld: true } },
        { $group: { _id: "$ownerId", n: { $sum: 1 } } },
      ])
      .toArray();
    const held = new Map(marked.map((row) => [row._id.toHexString(), row.n]));
    const excess: Record<string, number> = {};
    for (const [user, n] of Object.entries(counts?.users ?? {})) {
      const over = n - (held.get(user) ?? 0);
      if (over > 0) excess[user] = over;
    }
    const writes = counts?.writes ?? 0;
    const seen = this.excessSeen.get(key);
    if (Object.keys(excess).length === 0) {
      this.excessSeen.delete(key);
      return { released, repaired: false };
    }
    if (!seen || seen.writes !== writes) {
      this.excessSeen.set(key, { writes, excess, at: now });
      return { released, repaired: false };
    }
    // Only what both sweeps saw: a goal marked between them lowers it.
    const lower: Record<string, number> = {};
    for (const [user, n] of Object.entries(excess)) {
      const both = Math.min(n, seen.excess[user] ?? 0);
      if (both > 0) lower[user] = both;
    }
    if (Object.keys(lower).length === 0) {
      this.excessSeen.set(key, { writes, excess, at: now });
      return { released, repaired: false };
    }
    if (now - seen.at < GOAL_SLOT_REPAIR_QUIET_MS) {
      this.excessSeen.set(key, { ...seen, excess: lower });
      return { released, repaired: false };
    }
    this.excessSeen.delete(key);
    const sum = Object.values(lower).reduce((a, n) => a + n, 0);
    const filter: Record<string, unknown> = {
      _id: tenantId,
      // Absent on a document from before the counter: read as 0.
      writes: writes === 0 ? { $in: [0, null] } : writes,
      total: { $gte: sum },
    };
    const inc: Record<string, number> = { total: -sum, writes: 1 };
    for (const [user, n] of Object.entries(lower)) {
      filter[`users.${user}`] = { $gte: n };
      inc[`users.${user}`] = -n;
    }
    const repaired =
      (
        await this.slots(dbName).updateOne(filter as Filter<GoalSlotsDoc>, {
          $inc: inc,
        })
      ).modifiedCount === 1;
    if (repaired)
      this.logger.warn({
        message: "goal slot counts repaired",
        tenantId: tenantId.toHexString(),
        lowered: lower,
      });
    return { released, repaired };
  }

  // Takes the chat's goal watch for `owner` when no process holds it (never
  // watched, released, or lapsed) or `owner` already does. A compare-and-set
  // on the watch as read, so of two processes only one wins. Returns the
  // document with the saved cursor to resume from, or null.
  async claimWatch(
    dbName: string,
    chatId: ObjectId,
    owner: string,
  ): Promise<GoalDoc | null> {
    const goals = this.goals(dbName);
    const saved = await goals.findOne({ chatId, ended: false });
    if (!saved) return null;
    const seen = saved.watch ?? null;
    const now = new Date();
    if (seen && seen.owner && seen.owner !== owner && seen.leaseExpiresAt > now)
      return null;
    const watch: GoalWatch = {
      owner,
      leaseExpiresAt: new Date(now.getTime() + GOAL_WATCH_LEASE_MS),
      cursor: seen?.cursor ?? null,
    };
    // {watch: null} also matches a document written before watches.
    const unchanged: Filter<GoalDoc> = seen
      ? {
          "watch.owner": seen.owner,
          "watch.leaseExpiresAt": seen.leaseExpiresAt,
        }
      : { watch: null };
    return goals.findOneAndUpdate(
      { _id: saved._id, ended: false, ...unchanged },
      { $set: { watch } },
      { returnDocument: "after" },
    );
  }

  // Extends the lease while `owner` holds it.
  async renewWatch(
    dbName: string,
    chatId: ObjectId,
    owner: string,
  ): Promise<boolean> {
    if (!owner) return false;
    const renewed = await this.goals(dbName).updateOne(
      { chatId, "watch.owner": owner },
      {
        $set: {
          "watch.leaseExpiresAt": new Date(Date.now() + GOAL_WATCH_LEASE_MS),
        },
      },
    );
    return renewed.matchedCount === 1;
  }

  // Records where `owner` has read the chat stream up to.
  async saveCursor(
    dbName: string,
    chatId: ObjectId,
    owner: string,
    cursor: ChatCursor,
  ): Promise<boolean> {
    if (!owner) return false;
    const saved = await this.goals(dbName).updateOne(
      { chatId, "watch.owner": owner },
      { $set: { "watch.cursor": cursor } },
    );
    return saved.matchedCount === 1;
  }

  // Gives the watch up, keeping its cursor: owner "" with a lapsed lease is
  // free to claim at once and resumes where `owner` stopped.
  async releaseWatch(
    dbName: string,
    chatId: ObjectId,
    owner: string,
  ): Promise<void> {
    if (!owner) return;
    await this.goals(dbName).updateOne(
      { chatId, "watch.owner": owner },
      { $set: { "watch.owner": "", "watch.leaseExpiresAt": new Date(0) } },
    );
  }

  // Active goals of unended goal mode that no process watches at `now`:
  // never watched first, then oldest lapse first (active_watch). At most
  // `limit`.
  lapsedWatches(dbName: string, now: Date, limit: number): Promise<GoalDoc[]> {
    return this.goals(dbName)
      .find({
        "goal.status": "active",
        ended: false,
        // Missing, null or at most `now`.
        "watch.leaseExpiresAt": { $not: { $gt: now } },
      })
      .sort({ "watch.leaseExpiresAt": 1 })
      .limit(limit)
      .toArray();
  }

  // Saves a Codex goal update (applyUpdate, which also sets review pending
  // on a completion) and, when it applied, releases the goal's slot if it is
  // no longer active, then writes the chat's badge summary. Never claims a
  // slot: making a goal active through the goal API does (Task 10).
  async recordUpdate(
    dbName: string,
    tenantId: ObjectId,
    chat: { chatId: ObjectId; ownerId: ObjectId },
    update: GoalUpdateInput,
  ): Promise<{ applied: boolean; goal: GoalDoc | null }> {
    const { applied, before } = await this.applyUpdate(dbName, chat, update);
    if (!applied) return { applied, goal: before };
    // Only while the goal is still not active, so a goal made active again
    // in the meantime keeps the slot its claim found held.
    await this.releaseWhere(dbName, tenantId, {
      chatId: chat.chatId,
      "goal.status": { $ne: "active" },
    });
    const goal = await this.goals(dbName).findOne({ chatId: chat.chatId });
    if (goal) {
      await this.writeSummary(dbName, goal);
      this.publish(dbName, chat.chatId, { type: "goal.updated", goal });
    }
    return { applied, goal };
  }

  // The chat's badge summary, from the goal document as read after its
  // write. Guarded on the document's rev, so a summary from an older
  // revision never replaces a newer one, whatever order writers finish in.
  private async writeSummary(dbName: string, goal: GoalDoc): Promise<void> {
    const summary: ChatGoalSummary = {
      status: goal.goal.status,
      review: goal.review,
      rev: goal.rev,
    };
    await this.database
      .tenantDb(dbName)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .updateOne(
        {
          _id: goal.chatId,
          $or: [
            { goal: { $exists: false } },
            { "goal.rev": { $lt: goal.rev } },
          ],
        },
        { $set: { goal: summary } },
      );
  }

  // One atomic increment, filtered on both caps.
  private async take(
    dbName: string,
    tenantId: ObjectId,
    owner: string,
    tenantCap: number,
  ): Promise<boolean> {
    // An upsert cannot check a cap against a missing document.
    if (tenantCap < 1) return false;
    const user = `users.${owner}`;
    const filter: Filter<GoalSlotsDoc> = {
      _id: tenantId,
      total: { $lt: tenantCap },
      [user]: { $not: { $gte: GOAL_SLOTS_PER_USER } },
    };
    const update = { $inc: { total: 1, [user]: 1, writes: 1 } };
    const slots = this.slots(dbName);
    try {
      // Creates the tenant's document on its first claim.
      await slots.updateOne(filter, update, { upsert: true });
      return true;
    } catch (error) {
      // The document exists and a cap refused, or a concurrent first claim
      // created it: one more try against it, without creating.
      if (!isDuplicateKeyError(error)) throw error;
    }
    return (await slots.updateOne(filter, update)).modifiedCount === 1;
  }

  private async give(
    dbName: string,
    tenantId: ObjectId,
    owner: string,
  ): Promise<void> {
    const user = `users.${owner}`;
    const given = await this.slots(dbName).updateOne(
      { _id: tenantId, total: { $gt: 0 }, [user]: { $gt: 0 } },
      { $inc: { total: -1, [user]: -1, writes: 1 } },
    );
    if (given.modifiedCount === 0)
      this.logger.warn({
        message: "goal slot release found no count to lower",
        tenantId: tenantId.toHexString(),
      });
  }
}
