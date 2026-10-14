import type { DomainEvent, TurnTrace } from "../../../shared/contracts";
import type { Store } from "./store";
export async function persist(
  this: Pick<Store, "savePlan" | "messages" | "sessions" | "traces">,
  sessionId: string,
  event: DomainEvent,
) {
  if (event.type === "plan.updated")
    await this.savePlan(sessionId, {
      plan: event.data.plan,
      explanation: event.data.explanation,
      turnId: event.turnId,
      cursor: event.cursor,
      at: event.at,
    });
  if (event.type === "message.final")
    await this.messages.updateOne(
      {
        _id: `${sessionId}:assistant:${event.turnId}:${event.data.messageIndex ?? event.itemId}`,
      },
      {
        $set: {
          sessionId,
          role: "assistant",
          text: event.data.text,
          at: event.at,
          turnId: event.turnId,
          itemId: event.itemId,
          messageIndex: event.data.messageIndex,
        },
      },
      { upsert: true },
    );
  if (event.type === "approval.resolved")
    await this.sessions.updateOne(
      {
        _id: sessionId,
        "approvals.requestId": { $ne: event.data.requestId },
      },
      {
        $push: {
          approvals: { ...event.data, at: event.at, turnId: event.turnId },
        },
      },
    );
  if (event.type === "turn.completed" && event.data.timing)
    await this.sessions.updateOne(
      { _id: sessionId, "timings.turnId": { $ne: event.turnId } },
      { $push: { timings: event.data.timing } },
    );
  const trace = event.data?.trace as TurnTrace | undefined;
  if (event.type === "turn.completed" && trace?.turnId)
    await this.traces.updateOne(
      { _id: `${sessionId}:${trace.turnId}` },
      { $set: { ...trace, sessionId } },
      { upsert: true },
    );
}
