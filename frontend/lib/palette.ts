import type { ShortcutId } from "./shortcuts";

// The command palette's model (DESIGN-SPEC 10.6): groups, not a long list; one
// query filters label and keywords; destructive options are never the first
// selection.
export type PaletteGroup = "Go to" | "Actions";
const ORDER: PaletteGroup[] = ["Go to", "Actions"];
// Keeps a long history from turning into a long list; typing narrows it.
const PER_GROUP = 8;

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  keywords?: string;
  shortcut?: ShortcutId;
  danger?: boolean;
};

export function filterPalette(items: PaletteItem[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (item: PaletteItem) => {
    const text =
      `${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return ORDER.map((group) => ({
    group,
    items: items
      .filter((item) => item.group === group && hit(item))
      .slice(0, PER_GROUP),
  })).filter((g) => g.items.length > 0);
}

/** The option selected when the list changes: the first one that is safe. */
export function firstOption(options: { danger?: boolean }[]) {
  const safe = options.findIndex((option) => !option.danger);
  return safe === -1 ? options.length - 1 : safe;
}

/** ↑/↓ move the selection and wrap. */
export function moveOption(index: number, delta: number, count: number) {
  if (count === 0) return -1;
  return (((index + delta) % count) + count) % count;
}
