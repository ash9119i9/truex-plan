import type { IndexDescription, ObjectId } from "mongodb";
import type {
  ChatCursor,
  GoalOrigin,
  GoalStatus,
  RuntimeGoal,
} from "../chats/runtime-client";

export const GOALS_COLLECTION = "goals";
export const GOAL_SLOTS_COLLECTION = "goal_slots";

// Active goals one member may hold in a tenant, whatever the tenant's cap.
export const GOAL_SLOTS_PER_USER = 3;
// History entries kept per goal document; older ones are dropped.
export const GOAL_HISTORY_LIMIT = 60;

// How long a platform process holds a chat's goal watch without renewing it,
// as for run leases (LEASE_MS); the watcher renews every GOAL_WATCH_RENEW_MS.
export const GOAL_WATCH_LEASE_MS = 30_000;
export const GOAL_WATCH_RENEW_MS = 10_000;

// Truex's review of a goal Codex marked complete.
export type GoalReview = "none" | "pending" | "approved" | "accepted_as_is";

// Where an update came from on the adapter chat stream. Codex `updatedAt` is
// in whole seconds, so two updates in one second are ordered by this.
export type GoalPosition = ChatCursor;

// The platform process reading the chat's adapter stream for this goal.
// Released by setting owner "" and a lapsed lease, so the cursor stays for
// the next process to resume from.
export interface GoalWatch {
  owner: string;
  leaseExpiresAt: Date;
  // The last position read; null before the first snapshot.
  cursor: ChatCursor | null;
}

export interface GoalHistoryEntry {
  readonly at: Date;
  // set: a new goal (a new Codex createdAt); objective, budget and status:
  // changes Codex reported. The rest are the owner's review decisions.
  readonly kind:
    | "set"
    | "objective"
    | "budget"
    | "status"
    | "approved"
    | "accepted_as_is"
    | "changes_requested";
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
}

// One per chat (unique chatId), in the tenant database.
export interface GoalDoc {
  _id: ObjectId;
  chatId: ObjectId;
  // The chat's owner, whose slot an active goal holds.
  ownerId: ObjectId;
  // The latest goal Codex reported, as it reported it. A goal is identified
  // by its createdAt: Codex goals have no ID and edit an objective in place.
  goal: RuntimeGoal;
  origin: GoalOrigin;
  review: GoalReview;
  // Whether this goal counts in goal_slots. Flipped by compare-and-set, so a
  // claim or release changes the counts once per transition.
  slotHeld: boolean;
  // Goal mode was ended in this chat; no later update is applied.
  ended: boolean;
  // The stream position of the saved update, or null when it came from a
  // direct adapter answer.
  position: GoalPosition | null;
  // Newest last, at most GOAL_HISTORY_LIMIT.
  history: GoalHistoryEntry[];
  // Who reads the chat stream for it. Null (or missing, on documents written
  // before watches) when no process ever has.
  watch: GoalWatch | null;
  // Bumped on every write; a write applies only to the revision it read.
  rev: number;
  createdAt: Date;
  updatedAt: Date;
}

// One per tenant, _id = tenantId: active goals counted against the caps.
// `users` is keyed by the owner's hex ID.
export interface GoalSlotsDoc {
  _id: ObjectId;
  total: number;
  users: Record<string, number>;
  // Bumped by every slot taken or given; absent on documents written before
  // it (read as 0). The sweep's slot repair applies only to the value it read.
  writes?: number;
}

// How long an excess slot count must last, with no slot taken or given,
// before the goal sweep lowers it: longer than a start can wait on Codex
// (the cold-start allowance, then a pause) and than a release takes, so
// what is left is a crash.
export const GOAL_SLOT_REPAIR_QUIET_MS = 5 * 60_000;

export const GOAL_INDEXES: Readonly<Record<string, IndexDescription[]>> = {
  [GOALS_COLLECTION]: [
    // A chat has one goal document; concurrent first updates resolve on it.
    { key: { chatId: 1 }, name: "chat_unique", unique: true },
    // The sweep's slot repair reads only the goals that hold one.
    {
      key: { ownerId: 1 },
      name: "slot_held_owner",
      partialFilterExpression: { slotHeld: true },
    },
    // The sweep finds active goals that no process watches, unwatched first,
    // then oldest lapse first.
    {
      key: { "watch.leaseExpiresAt": 1 },
      name: "active_watch",
      partialFilterExpression: { "goal.status": "active" },
    },
  ],
};
