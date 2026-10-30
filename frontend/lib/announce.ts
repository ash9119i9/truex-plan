import { useSyncExternalStore } from "react";

// The one polite live region (DESIGN-SPEC 11.12). Every status sentence (stop,
// steer, compaction, uploads, helper and request changes) goes through announce().
// Each message gets its own node, so two quick or identical messages are both
// read instead of the second replacing the first.
export type Announcement = { id: number; text: string };

const KEEP_MS = 7000;
const LIMIT = 5;

export function createAnnouncer() {
  let list: Announcement[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    announce(text: string) {
      const clean = text.trim();
      if (!clean) return null;
      const id = next++;
      list = [...list, { id, text: clean }].slice(-LIMIT);
      emit();
      return id;
    },
    expire(id: number) {
      list = list.filter((message) => message.id !== id);
      emit();
    },
    messages: () => list,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const shared = createAnnouncer();
const NONE: Announcement[] = [];

export function announce(text: string) {
  const id = shared.announce(text);
  if (id !== null) setTimeout(() => shared.expire(id), KEEP_MS);
}

export function useAnnouncements() {
  return useSyncExternalStore(shared.subscribe, shared.messages, () => NONE);
}
