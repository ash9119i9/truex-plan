export interface ConversationOrder {
  _id: string;
  at: string;
  order?: number;
  command?: { afterMessageId?: string };
}

// Runtime reconciliation assigns order only to runtime messages. Insert command
// records after their saved predecessor, so reconciliation cannot move them below
// the answers they triggered (runtime timestamps may be reconstructed).
export function orderConversation<T extends ConversationOrder>(
  messages: T[],
): T[] {
  const chronological = [...messages].sort(
    (a, b) => a.at.localeCompare(b.at) || a._id.localeCompare(b._id),
  );
  const result = chronological
    .filter((m) => !m.command)
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER),
    );
  const remaining = chronological.filter((m) => m.command);
  const tails = new Map<string, string>();
  while (remaining.length) {
    const ready = remaining.findIndex(
      (m) =>
        !m.command!.afterMessageId ||
        !remaining.some((other) => other._id === m.command!.afterMessageId),
    );
    const [message] = remaining.splice(ready < 0 ? 0 : ready, 1);
    const anchor = message.command!.afterMessageId || "";
    const predecessor = tails.get(anchor) || anchor;
    const index = result.findIndex((m) => m._id === predecessor);
    result.splice(index + 1, 0, message);
    tails.set(anchor, message._id);
  }
  return result;
}
