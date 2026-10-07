import { visibleEntries, type Entry } from "./chat.ts";

export interface ChatGroup {
  id: string;
  user?: Extract<Entry, { kind: "message" }>;
  entries: Entry[];
  turnId?: string;
  visualIds?: string[];
}

// One selector per chat surface. Unchanged groups keep their object identity so
// React can skip historical rows while a live entry changes. Nothing is retained
// beyond the current transcript, and reset/new chats cannot reuse old content.
export function createChatGroupSelector() {
  let previous: ChatGroup[] = [];
  return (entries: Entry[]): ChatGroup[] => {
    const groups: ChatGroup[] = [];
    const visualsByTurn = new Map<string, string[]>();
    for (const entry of entries) {
      if (entry.kind !== "visual") continue;
      const ids = visualsByTurn.get(entry.turnId) ?? [];
      ids.push(entry.visual.id);
      visualsByTurn.set(entry.turnId, ids);
    }
    for (const entry of visibleEntries(entries)) {
      if (entry.kind === "item") continue;
      if (entry.kind === "message" && entry.role === "user") {
        groups.push({ id: entry.id, user: entry, entries: [] });
      } else {
        const last = groups.at(-1);
        if (last && !last.user && last.turnId === entry.turnId)
          last.entries.push(entry);
        else
          groups.push({ id: entry.id, turnId: entry.turnId, entries: [entry] });
      }
    }
    const byId = new Map(
      previous.map((group) => [
        `${group.user ? "user" : "assistant"}:${group.id}`,
        group,
      ]),
    );
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!group.user && group.turnId)
        group.visualIds = visualsByTurn.get(group.turnId);
      const old = byId.get(`${group.user ? "user" : "assistant"}:${group.id}`);
      if (
        old &&
        old.user === group.user &&
        old.turnId === group.turnId &&
        old.entries.length === group.entries.length &&
        (old.visualIds?.length ?? 0) === (group.visualIds?.length ?? 0) &&
        (old.visualIds ?? []).every(
          (id, index) => id === group.visualIds?.[index],
        ) &&
        old.entries.every((entry, index) => entry === group.entries[index])
      )
        groups[i] = old;
    }
    if (
      previous.length === groups.length &&
      previous.every((group, i) => group === groups[i])
    )
      return previous;
    previous = groups;
    return groups;
  };
}
