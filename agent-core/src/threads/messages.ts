import type { Thread } from "./state";
import type { ThreadEvents } from "./events";

// Apply the existing reasoning and assistant-message projections in notification order.
export function projectMessages(
  t: Thread,
  method: string,
  p: any,
  turnId: any,
  itemId: any,
  begin: number,
  events: Pick<ThreadEvents, "emit">,
) {
  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta" ||
    (method === "item/completed" && p.item?.type === "reasoning")
  ) {
    let thinking = t.thinking.find(
      (r) => r.id === itemId && r.turnId === turnId,
    );
    if (!thinking) {
      thinking = { id: itemId, turnId, summary: "", raw: "", done: false };
      t.thinking.push(thinking);
    }
    if (method === "item/reasoning/summaryTextDelta")
      thinking.summary += p.delta;
    if (method === "item/reasoning/textDelta") thinking.raw += p.delta;
    if (method === "item/completed") {
      thinking.summary = (p.item.summary || []).join("\n") || thinking.summary;
      thinking.done = true;
    }
    if (t.thinking.length > 100) t.thinking.shift();
  }
  if (method === "item/agentMessage/delta") {
    let message = t.messages.find((x) => x.id === itemId);
    if (!message) {
      message = {
        id: itemId,
        turnId,
        text: "",
        final: false,
        messageIndex:
          Math.max(
            -1,
            ...t.messages
              .filter((x) => x.turnId === turnId)
              .map((x) => x.messageIndex ?? -1),
          ) + 1,
      };
      t.messages.push(message);
    }
    message.text += p.delta;
    p = { ...p, messageIndex: message.messageIndex };
    if (t.clock && t.clock.turnId === turnId) {
      const c = t.clock;
      if (c.first === null) c.first = begin;
      if (c.last !== null) c.gap = Math.max(c.gap, begin - c.last);
      c.last = begin;
      c.count++;
    }
  }
  if (method === "item/completed" && p.item?.type === "agentMessage") {
    const previous = t.messages.find((x) => x.id === itemId);
    const message = {
      id: itemId,
      turnId,
      text: p.item.text,
      final: true,
      messageIndex:
        previous?.messageIndex ??
        Math.max(
          -1,
          ...t.messages
            .filter((x) => x.turnId === turnId)
            .map((x) => x.messageIndex ?? -1),
        ) + 1,
    };
    const index = t.messages.findIndex((x) => x.id === itemId);
    if (index < 0) t.messages.push(message);
    else t.messages[index] = message;
    if (t.clock && t.clock.turnId === turnId && t.clock.first === null) {
      t.clock.first = begin;
      t.clock.last = begin;
    }
    const messageIndex = message.messageIndex;
    events.emit(
      t,
      "message.final",
      { text: p.item.text, messageIndex },
      turnId,
      itemId,
    );
    if (t.messages.length > 1000)
      t.messages.splice(0, t.messages.length - 1000);
  }
  return p;
}
