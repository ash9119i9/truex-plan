import { publicPlan, type PlanStep } from "../public/conversation";
import type { Store } from "./store";
// Latest plan of a session, so the sidebar survives reload and agent-core
// restart. Steps are stored already projected to {step, status}.
export interface StoredPlan {
  steps: PlanStep[];
  explanation?: string;
  turnId?: string;
  // agent-core cursor "<generation>:<seq>" of the update, when known.
  cursor?: string;
  // When the update happened (event time, or save time for a snapshot).
  eventAt: string;
  updatedAt: string;
  // Compare-and-set guard for concurrent savers.
  version: number;
}
export interface PlanUpdate {
  plan: unknown;
  explanation?: unknown;
  turnId?: string;
  cursor?: string;
  at?: string;
}
function cursorParts(cursor?: string) {
  const i = cursor ? cursor.lastIndexOf(":") : -1;
  if (!cursor || i < 0) return null;
  const seq = Number(cursor.slice(i + 1));
  return Number.isFinite(seq) ? { generation: cursor.slice(0, i), seq } : null;
}
// Within one agent-core generation the sequence number orders updates. Across
// generations (restart) the event time does. A replayed or delayed older
// update therefore never replaces a newer plan.
export function newerPlan(saved: StoredPlan | undefined, next: PlanUpdate) {
  if (!saved) return true;
  const a = cursorParts(saved.cursor),
    b = cursorParts(next.cursor);
  if (a && b && a.generation === b.generation) return b.seq > a.seq;
  const savedAt = Date.parse(saved.eventAt),
    nextAt = Date.parse(next.at ?? "");
  if (Number.isNaN(savedAt) || Number.isNaN(nextAt)) return true;
  return nextAt >= savedAt;
}
// Saves the plan unless a newer one is already stored. Returns whether it
// was written.
export async function savePlan(
  this: Pick<Store, "sessions">,
  sessionId: string,
  update: PlanUpdate,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await this.sessions.findOne(
      { _id: sessionId },
      { projection: { plan: 1 } },
    );
    if (!session) return false;
    const saved = session.plan;
    if (!newerPlan(saved, update)) return false;
    const now = new Date().toISOString();
    const plan: StoredPlan = {
      steps: publicPlan(update.plan),
      ...(typeof update.explanation === "string" && update.explanation
        ? { explanation: update.explanation }
        : {}),
      ...(typeof update.turnId === "string" ? { turnId: update.turnId } : {}),
      ...(typeof update.cursor === "string" ? { cursor: update.cursor } : {}),
      eventAt:
        update.at && !Number.isNaN(Date.parse(update.at)) ? update.at : now,
      updatedAt: now,
      version: (saved?.version ?? 0) + 1,
    };
    const result = await this.sessions.updateOne(
      { _id: sessionId, "plan.version": saved?.version ?? null },
      { $set: { plan } },
    );
    if (result.modifiedCount) return true;
  }
  return false;
}
