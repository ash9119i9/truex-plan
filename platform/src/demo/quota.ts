import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors";
import type { Store } from "../persistence/store";
import type { DemoConfig } from "./demo";

// Public demo work limits.
//
// Every new turn in the demo tenant is reserved before it is dispatched, in
// one catalog transaction: the person's daily counter, the demo-wide daily
// counter and the reservation row commit together or not at all. Past either
// ceiling the transaction aborts, so a refusal spends nothing.
//
// A reservation is keyed by person, workspace, conversation and clientId, so
// a retried submission of the same logical turn is recognised and never
// counted twice, and one person's clientId can never collide with another's.
// Reservations are kept 48 hours; beyond that the durable conversation record
// (the stored user message) is what recognises an already-seen turn.

const DAY = 86_400_000;
export const RESERVATION_MS = 2 * DAY;

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);
/** The next 00:00 UTC. */
export const nextReset = (now: Date) => new Date(Date.parse(utcDay(now)) + DAY);

export class QuotaError extends ApiError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(429, message, "DEMO_QUOTA_EXCEEDED");
  }
}

const exceeded = (what: string, now: Date) => {
  const reset = nextReset(now);
  return new QuotaError(
    `${what} Try again after ${reset.toISOString().slice(11, 16)} UTC (${reset.toISOString()}).`,
    Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000)),
  );
};

export interface TurnKey {
  userId: string;
  tenantId: string;
  conversationId: string;
  clientId: string;
}

export class DemoQuota {
  constructor(
    private readonly store: Store,
    private readonly config: DemoConfig,
  ) {}

  /** Whether the given workspace carries the demo limits. */
  applies(tenantId: string) {
    return tenantId === this.config.tenantId;
  }

  /**
   * Reserves one turn. `duplicate` means this exact turn was reserved before:
   * nothing more is counted and the caller carries on with its normal
   * duplicate handling.
   */
  async reserve(
    key: TurnKey,
    now = new Date(),
  ): Promise<{ duplicate: boolean }> {
    // Two submissions of one logical turn can both find no reservation and both
    // insert; the unique index lets one win. The loser runs again, sees the
    // winner's reservation, and counts nothing.
    for (let attempt = 0; ; attempt++)
      try {
        return await this.reserveOnce(key, now);
      } catch (error) {
        if ((error as { code?: number })?.code !== 11000 || attempt >= 2)
          throw error;
      }
  }
  private async reserveOnce(
    key: TurnKey,
    now: Date,
  ): Promise<{ duplicate: boolean }> {
    const { turnsPerUser, turnsGlobal } = this.config;
    // Missing never means unlimited: readiness refuses an unset ceiling, and so
    // does this, should the gate ever be bypassed.
    if (turnsGlobal === undefined)
      throw new ApiError(
        503,
        "The demo is not available right now.",
        "DEMO_UNAVAILABLE",
      );
    const day = utcDay(now);
    const expiresAt = new Date(now.getTime() + 3 * DAY);
    return this.store.withCatalogTransaction(async (session) => {
      const seen = await this.store.demoTurns.findOne(
        {
          userId: key.userId,
          tenantId: key.tenantId,
          conversationId: key.conversationId,
          clientId: key.clientId,
        },
        { session },
      );
      // A released reservation is a turn that never ran; reserving it again is
      // a fresh attempt and counts again.
      if (seen && seen.state === "reserved") return { duplicate: true };
      const counter = (id: string) =>
        this.store.demoUsage.findOneAndUpdate(
          { _id: `${day}:${key.tenantId}:${id}` },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
          { upsert: true, returnDocument: "after", session },
        );
      const person = await counter(`u:${key.userId}`);
      if (!person || person.count > turnsPerUser)
        throw exceeded(
          `You have used today's ${turnsPerUser} demo messages.`,
          now,
        );
      const everyone = await counter("*");
      if (!everyone || everyone.count > turnsGlobal)
        throw exceeded("The demo has reached its limit for today.", now);
      const reservation = {
        userId: key.userId,
        tenantId: key.tenantId,
        conversationId: key.conversationId,
        clientId: key.clientId,
        day,
        state: "reserved" as const,
        at: now,
        expiresAt: new Date(now.getTime() + RESERVATION_MS),
      };
      if (seen)
        await this.store.demoTurns.updateOne(
          { _id: seen._id, state: "released" },
          { $set: reservation },
          { session },
        );
      else
        await this.store.demoTurns.insertOne(
          { _id: randomUUID(), ...reservation },
          { session },
        );
      return { duplicate: false };
    });
  }

  /**
   * Gives a reservation back, once, when the turn is known never to have
   * reached the runtime (it was refused, or setup failed before dispatch). A
   * timeout or an unclear outcome is not released: the turn may have run.
   * Safe to call again; only a "reserved" row is released.
   */
  async release(key: TurnKey): Promise<boolean> {
    return this.store.withCatalogTransaction(async (session) => {
      const row = await this.store.demoTurns.findOneAndUpdate(
        {
          userId: key.userId,
          tenantId: key.tenantId,
          conversationId: key.conversationId,
          clientId: key.clientId,
          state: "reserved",
        },
        { $set: { state: "released" } },
        { returnDocument: "before", session },
      );
      if (!row) return false;
      for (const id of [`u:${key.userId}`, "*"])
        await this.store.demoUsage.updateOne(
          { _id: `${row.day}:${key.tenantId}:${id}`, count: { $gt: 0 } },
          { $inc: { count: -1 } },
          { session },
        );
      return true;
    });
  }
}
