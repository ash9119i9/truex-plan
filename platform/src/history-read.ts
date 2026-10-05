import type { Collection } from "mongodb";
import type { Message } from "../../shared/contracts";
import {
  orderConversation,
  type ConversationOrder,
} from "../../shared/command-history";
import { historyWindow, type HistoryBoundary } from "./history-window";
import { ApiError } from "./errors";

// Small conversations keep their single payload read. For larger histories,
// ordering still covers every record, but only page bodies cross the DB boundary.
export const SMALL_HISTORY_LIMIT = 250;
export async function readHistoryWindow(
  collection: Collection<Message>,
  sessionId: string,
  beforeMessageId?: string,
) {
  const sample = await collection
    .find({ sessionId })
    .limit(SMALL_HISTORY_LIMIT + 1)
    .toArray();
  if (sample.length <= SMALL_HISTORY_LIMIT)
    return historyWindow(orderConversation(sample), sessionId, beforeMessageId);

  const headers = await collection
    .find<ConversationOrder & HistoryBoundary>(
      { sessionId },
      {
        projection: {
          _id: 1,
          at: 1,
          role: 1,
          order: 1,
          "command.afterMessageId": 1,
        },
      },
    )
    .toArray();
  const page = historyWindow(
    orderConversation(headers),
    sessionId,
    beforeMessageId,
  );
  const bodies = await collection
    .find({ sessionId, _id: { $in: page.messages.map((m) => m._id) } })
    .toArray();
  const byId = new Map(bodies.map((m) => [m._id, m]));
  const messages = page.messages.map((header) => {
    const body = byId.get(header._id);
    if (!body)
      throw new ApiError(
        409,
        "This conversation page changed while loading. Reopen the conversation to refresh its history.",
        "HISTORY_CURSOR_STALE",
      );
    return body;
  });
  return { messages, historyWindow: page.historyWindow };
}
