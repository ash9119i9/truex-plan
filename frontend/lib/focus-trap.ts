"use client";
import { useEffect, type RefObject } from "react";

// Where Tab should move inside a trap: the first stop after the last, the last
// before the first, the first (or last) when focus escaped. null leaves the
// move to the browser; undefined means there is nowhere to go.
export function trapTab<T>(
  stops: readonly T[],
  active: T | null,
  shift: boolean,
): T | null | undefined {
  if (stops.length === 0) return undefined;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const at = active === null ? -1 : stops.indexOf(active);
  if (at < 0) return shift ? last : first;
  if (!shift && active === last) return first;
  if (shift && active === first) return last;
  return null;
}

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Keeps Tab inside `box` while `active` (a modal drawer or dialog).
export function useFocusTrap(
  box: RefObject<HTMLElement | null> | (() => HTMLElement | null),
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const node = () => (typeof box === "function" ? box() : box.current);
    const onKey = (e: KeyboardEvent) => {
      const root = node();
      if (e.key !== "Tab" || !root) return;
      const stops = Array.from(
        root.querySelectorAll<HTMLElement>(TABBABLE),
      ).filter((el) => el.getClientRects().length > 0);
      const next = trapTab(
        stops,
        document.activeElement as HTMLElement | null,
        e.shiftKey,
      );
      if (next === null) return;
      e.preventDefault();
      next?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [box, active]);
}
