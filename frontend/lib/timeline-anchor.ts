import { createChatGroupSelector } from "./chat-groups.ts";
import type { Entry } from "./chat.ts";

// Match ChatMessages' global anchors, including the first group of a reused turn.
// Virtualized rows need an index before their DOM element can be mounted/focused.
export function timelineAnchorIndex(entries: Entry[], id: string) {
  const groups = createChatGroupSelector()(entries);
  const anchored = new Set<string>();
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (group.user && id === `request-${group.user.id}`) return index;
    if (!group.user && group.turnId && !anchored.has(group.turnId)) {
      if (id === `turn-${group.turnId}`) return index;
      anchored.add(group.turnId);
    }
    if (
      group.entries.some(
        (entry) =>
          entry.kind === "agents" &&
          id === `helpers-${entry.id.replace(/[^\w-]/g, "-")}`,
      )
    )
      return index;
  }
  return undefined;
}
