import type { DomainEvent } from "../../shared/contracts";

// Unknown reasoning metadata may carry a boundary signal. Keep such frames
// intact rather than dropping it from a merged projection-only frame.
const reasoningKeys = new Set([
  "delta",
  "method",
  "threadId",
  "turnId",
  "itemId",
  "messageIndex",
  "summaryIndex",
  "contentIndex",
  "channel",
]);
const reasoningIdentity = [
  "method",
  "channel",
  "summaryIndex",
  "contentIndex",
] as const;
const validOrdinal = (value: unknown) =>
  value === undefined ||
  (Number.isSafeInteger(value) && (value as number) >= 0);

// Projection-only input: callers must retain the original frames for cursor
// deduplication, checkpoints, follow policy, telemetry and other projections.
export function coalesceChatEvents(
  events: readonly DomainEvent[],
): DomainEvent[] {
  const projected: DomainEvent[] = [];
  let head: DomainEvent | undefined;
  let fragments: string[] = [];
  const flush = () => {
    if (!head) return;
    projected.push(
      fragments.length === 1
        ? head
        : { ...head, data: { ...head.data, delta: fragments.join("") } },
    );
    head = undefined;
    fragments = [];
  };
  for (const event of events) {
    const ordinal = event?.data?.messageIndex;
    const compatible =
      (event?.type === "message.delta" || event?.type === "reasoning.delta") &&
      typeof event.threadId === "string" &&
      !!event.threadId &&
      typeof event.turnId === "string" &&
      !!event.turnId &&
      typeof event.itemId === "string" &&
      !!event.itemId &&
      !!event.data &&
      typeof event.data === "object" &&
      !Array.isArray(event.data) &&
      typeof event.data.delta === "string" &&
      validOrdinal(ordinal) &&
      (event.type !== "reasoning.delta" ||
        (Object.keys(event.data).every((key) => reasoningKeys.has(key)) &&
          [
            undefined,
            "item/reasoning/textDelta",
            "item/reasoning/summaryTextDelta",
          ].includes(event.data.method) &&
          (event.data.channel === undefined ||
            typeof event.data.channel === "string") &&
          validOrdinal(event.data.summaryIndex) &&
          validOrdinal(event.data.contentIndex) &&
          ["threadId", "turnId", "itemId"].every(
            (key) =>
              event.data[key] === undefined ||
              event.data[key] ===
                event[key as "threadId" | "turnId" | "itemId"],
          )));
    if (!compatible) {
      flush();
      projected.push(event);
      continue;
    }
    if (
      head &&
      (head.type !== event.type ||
        head.threadId !== event.threadId ||
        head.turnId !== event.turnId ||
        head.itemId !== event.itemId ||
        head.data.messageIndex !== ordinal ||
        (event.type === "reasoning.delta" &&
          reasoningIdentity.some((key) => head!.data[key] !== event.data[key])))
    )
      flush();
    head ??= event;
    fragments.push(event.data.delta);
  }
  flush();
  return projected;
}
