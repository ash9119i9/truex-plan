import type { ApprovalView, LiveReply } from "./tenant-chat";
import type { ApprovalAnswer } from "./tenant-connectors";

// The request dock (DESIGN-SPEC 10.4, 13.1): one blocking request at a time,
// docked above the composer, oldest first.

// Pending requests of a live reply, in the order their steps appeared.
export function dockQueue(reply: LiveReply | null): ApprovalView[] {
  if (!reply) return [];
  const order = new Map<string, number>();
  reply.items.forEach((item, index) => {
    if ("itemId" in item) order.set(item.itemId, index);
  });
  return Object.values(reply.approvals)
    .filter((approval) => approval.status === "pending")
    .map((approval, index) => ({ approval, index }))
    .sort(
      (a, b) =>
        (order.get(a.approval.itemId) ?? Infinity) -
          (order.get(b.approval.itemId) ?? Infinity) || a.index - b.index,
    )
    .map(({ approval }) => approval);
}

export type Countdown = {
  text: string;
  label: string;
  /** The last minute, or expired. */
  warn: boolean;
  expired: boolean;
};

// The card's text countdown: "4:59" under an hour, "1h 05m" above.
export function countdown(
  expiresAt: string | null,
  now: number,
): Countdown | null {
  const end = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(end)) return null;
  const left = Math.floor((end - now) / 1000);
  if (left < 0)
    return { text: "Expired", label: "Expired", warn: true, expired: true };
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  const text = hours
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
  const label =
    left >= 60
      ? `Expires in ${Math.floor(left / 60)} minute${left >= 120 ? "s" : ""}`
      : `Expires in ${left} second${left === 1 ? "" : "s"}`;
  return { text, label, warn: left < 60, expired: false };
}

// The card's key hints: 1 allows once, 2 allows for the chat (when offered),
// Esc doesn't allow.
export function requestKey(
  key: string,
  card: { allowForChat: boolean },
): ApprovalAnswer | null {
  if (key === "1") return "allow";
  if (key === "2" && card.allowForChat) return "allow_for_chat";
  if (key === "Escape") return "deny";
  return null;
}

// Wraps an async action so a second call while the first is in flight does
// nothing (a double click sends one decision).
export function onceAtATime<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  let running = false;
  return async (...args: A) => {
    if (running) return;
    running = true;
    try {
      await action(...args);
    } finally {
      running = false;
    }
  };
}

// The audit row a settled request leaves in the stream (DESIGN-SPEC 13.6).
// Declined, stopped and timed-out are neutral, never an error colour.
export type RecordView = {
  badge: string;
  tone: "ok" | "neutral";
  summary: "You answered" | "Closed";
};
export function recordOf(
  decision: "allow" | "allow_for_chat" | "deny" | "expired" | "cancelled",
): RecordView {
  switch (decision) {
    case "allow":
      return { badge: "Allowed once", tone: "ok", summary: "You answered" };
    case "allow_for_chat":
      return {
        badge: "Allowed for this chat",
        tone: "ok",
        summary: "You answered",
      };
    case "deny":
      return { badge: "Not allowed", tone: "neutral", summary: "You answered" };
    case "expired":
      return {
        badge: "No answer — timed out",
        tone: "neutral",
        summary: "Closed",
      };
    case "cancelled":
      return {
        badge: "No answer — stopped",
        tone: "neutral",
        summary: "Closed",
      };
  }
}
