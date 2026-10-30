// Sidebar history (DESIGN-SPEC 11.2): Today · Previous · Last 30 days · ‹Month›.
// Today and Previous show; the older groups fold behind "View all conversations".

const DAY = 86_400_000;

export function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Calendar days between two local dates (DST-safe: rounds the 23/25-hour days).
const daysBetween = (earlier: Date, later: Date) =>
  Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);

export interface HistoryGroup<T> {
  label: string;
  rows: T[];
  /** Folded behind "View all conversations". */
  older: boolean;
}

// Rows keep their incoming order inside a group; groups keep a fixed order.
export function historyGroups<T>(
  rows: readonly T[],
  timeOf: (row: T) => string,
  now = new Date(),
): HistoryGroup<T>[] {
  const groups = new Map<string, HistoryGroup<T> & { rank: number }>();
  for (const row of rows) {
    const when = new Date(timeOf(row));
    let label: string;
    let rank: number;
    if (Number.isNaN(when.getTime())) {
      label = "Earlier";
      rank = Number.MAX_SAFE_INTEGER;
    } else {
      const days = daysBetween(when, now);
      if (days <= 0) [label, rank] = ["Today", 0];
      else if (days < 7) [label, rank] = ["Previous", 1];
      else if (days < 30) [label, rank] = ["Last 30 days", 2];
      else {
        const sameYear = when.getFullYear() === now.getFullYear();
        label = when.toLocaleDateString("en-US", {
          month: "long",
          year: sameYear ? undefined : "numeric",
        });
        // Newer months first.
        rank =
          3 +
          (now.getFullYear() - when.getFullYear()) * 12 +
          (now.getMonth() - when.getMonth());
      }
    }
    const group = groups.get(label);
    if (group) group.rows.push(row);
    else groups.set(label, { label, rows: [row], older: rank >= 2, rank });
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ label, rows, older }) => ({ label, rows, older }));
}

/** "now", "12m", "1h" today; a weekday this week; "Oct 18" beyond. */
export function sessionTime(iso: string, now = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const days = daysBetween(when, now);
  if (days <= 0) {
    const minutes = Math.floor((now.getTime() - when.getTime()) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }
  if (days < 7) return when.toLocaleDateString("en-US", { weekday: "short" });
  return when.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: when.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
