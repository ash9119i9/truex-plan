import { useRef, type KeyboardEvent } from "react";

// Roving focus for tablists, radiogroups and menus (DESIGN-SPEC 9.9, 9.10, 9.13):
// one stop in the tab order, arrows move and wrap, Home/End jump, disabled items
// are skipped, and selection follows focus.
export type RovingItem = { disabled?: boolean };
export type Axis = "horizontal" | "vertical" | "both";

const enabled = (items: RovingItem[]) =>
  items.flatMap((item, i) => (item.disabled ? [] : [i]));

/** The index the key moves to, or null when the key isn't a roving key. */
export function rovingMove(
  key: string,
  current: number,
  items: RovingItem[],
  axis: Axis,
): number | null {
  const usable = enabled(items);
  if (!usable.length) return null;
  const across = axis !== "vertical";
  const down = axis !== "horizontal";
  const forward =
    (across && key === "ArrowRight") || (down && key === "ArrowDown");
  const back = (across && key === "ArrowLeft") || (down && key === "ArrowUp");
  if (key === "Home") return usable[0];
  if (key === "End") return usable[usable.length - 1];
  if (!forward && !back) return null;
  const at = usable.indexOf(current);
  if (at < 0) return forward ? usable[0] : usable[usable.length - 1];
  const step = forward ? 1 : -1;
  return usable[(at + step + usable.length) % usable.length];
}

/** The one item in the tab order: the selected one, else the first enabled one. */
export function rovingStop(selected: number, items: RovingItem[]): number {
  if (items[selected] && !items[selected].disabled) return selected;
  return enabled(items)[0] ?? -1;
}

export function useRovingFocus(
  items: RovingItem[],
  selected: number,
  onSelect: (index: number) => void,
  axis: Axis,
) {
  const nodes = useRef<(HTMLElement | null)[]>([]);
  const stop = rovingStop(selected, items);
  return {
    ref: (index: number) => (node: HTMLElement | null) => {
      nodes.current[index] = node;
    },
    tabIndex: (index: number) => (index === stop ? 0 : -1),
    focus: (index: number) => nodes.current[index]?.focus(),
    onKeyDown(event: KeyboardEvent) {
      const next = rovingMove(event.key, selected, items, axis);
      if (next === null) return;
      event.preventDefault();
      if (next !== selected) onSelect(next);
      nodes.current[next]?.focus();
    },
  };
}
