"use client";
import { useEffect, useRef } from "react";

// Global shortcuts per the design spec (Layout & shell §6, app.tsx:262-274).
// Combo = (meta || ctrl ? "mod+" : "") + key.toLowerCase(); Shift/Alt ignored,
// no focus filter (fires while typing too). preventDefault on a match.
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

export function hotkeyCombo(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">) {
  return (e.metaKey || e.ctrlKey ? "mod+" : "") + e.key.toLowerCase();
}

export function useHotkeys(map: HotkeyMap) {
  // Latest map without re-binding the listener on every render.
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.key) return;
      const fn = ref.current[hotkeyCombo(e)];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
