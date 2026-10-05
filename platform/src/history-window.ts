import { ApiError } from "./errors";

export interface HistoryBoundary {
  _id: string;
  role: string;
  command?: unknown;
}

// This cursor anchors the authoritative conversation order, not a timestamp:
// commands and reconstructed runtime messages can share the same timestamp.
export function historyAnchor(
  sessionId: string,
  cursor: unknown,
): string | undefined {
  if (cursor === undefined) return undefined;
  const invalid = () =>
    new ApiError(
      400,
      "The conversation page cursor is invalid. Reopen the conversation.",
      "INVALID_HISTORY_CURSOR",
    );
  if (
    typeof cursor !== "string" ||
    cursor.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  )
    throw invalid();
  let data: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw invalid();
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const value = data as { sessionId?: unknown; beforeMessageId?: unknown };
  if (
    value.sessionId !== sessionId ||
    typeof value.beforeMessageId !== "string" ||
    !value.beforeMessageId ||
    value.beforeMessageId.length > 500
  )
    throw invalid();
  return value.beforeMessageId;
}

export function historyWindow<T extends HistoryBoundary>(
  messages: T[],
  sessionId: string,
  beforeMessageId?: string,
) {
  const end =
    beforeMessageId === undefined
      ? messages.length
      : messages.findIndex((message) => message._id === beforeMessageId);
  if (end < 0)
    throw new ApiError(
      409,
      "This conversation page is no longer available. Reopen the conversation to refresh its history.",
      "HISTORY_CURSOR_STALE",
    );
  const requestLimit = beforeMessageId === undefined ? 10 : 20;
  let start = 0,
    requests = 0;
  for (let index = end - 1; index >= 0; index--) {
    // Commands belong with their predecessor; they do not create an extra
    // pagination boundary that could separate a request from its answers.
    if (
      messages[index].role === "user" &&
      !messages[index].command &&
      ++requests === requestLimit
    ) {
      start = index;
      break;
    }
  }
  if (
    start > 0 &&
    !messages.some(
      (message, index) =>
        index < start && message.role === "user" && !message.command,
    )
  )
    start = 0;
  const selected = messages.slice(start, end);
  return {
    messages: selected,
    historyWindow: {
      hasOlder: start > 0,
      beforeCursor:
        start > 0
          ? Buffer.from(
              JSON.stringify({
                sessionId,
                beforeMessageId: messages[start]._id,
              }),
            ).toString("base64url")
          : null,
    },
  };
}
