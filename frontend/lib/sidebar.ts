export interface SidebarSession {
  _id: string;
  title?: string;
  createdAt: string;
}

export const SIDEBAR_INITIAL_COUNT = 10;
export const SIDEBAR_PAGE_COUNT = 25;

const DAY = 86_400_000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" vs "Earlier" by the session's local createdAt date. */
export function convoGroup(
  createdAt: string,
  now = new Date(),
): "Today" | "Earlier" {
  return startOfDay(new Date(createdAt)) === startOfDay(now)
    ? "Today"
    : "Earlier";
}

/** h:mm AM/PM today, short weekday within 7 days, else short date. */
export function convoTime(createdAt: string, now = new Date()): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days <= 0)
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function groupSidebarSessions<S extends SidebarSession>(
  sessions: readonly S[],
  now: Date,
) {
  const today: S[] = [],
    earlier: S[] = [];
  for (const session of sessions)
    (convoGroup(session.createdAt, now) === "Today" ? today : earlier).push(
      session,
    );
  return { today, earlier };
}

// Limit mounted history rows, keeping the selected conversation reachable even
// when it came from Search or the shelf is collapsed. The full source is untouched.
export function sidebarWindow<S extends Pick<SidebarSession, "_id">>(
  sessions: readonly S[],
  {
    count = SIDEBAR_INITIAL_COUNT,
    activeId,
    expanded = true,
  }: {
    count?: number;
    activeId?: string | null;
    expanded?: boolean;
  } = {},
) {
  const limit = Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : SIDEBAR_INITIAL_COUNT;
  const items = expanded ? sessions.slice(0, limit) : [];
  if (activeId && !items.some((session) => session._id === activeId)) {
    const active = sessions.find((session) => session._id === activeId);
    if (active) items.push(active);
  }
  return { items, hiddenCount: sessions.length - items.length };
}
