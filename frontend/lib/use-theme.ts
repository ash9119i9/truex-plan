"use client";
import { useCallback, useSyncExternalStore } from "react";
import { resolveTheme } from "./theme-boot";

// The theme choice for React. The attributes on <html>, set by THEME_BOOT_SCRIPT before first
// paint (lib/theme-boot.ts), are the state; this hook reads them and writes a new choice.
export type Theme = "auto" | "light" | "dark";
const KEY = "tx-sys-theme";
const QUERIES = [
  "(prefers-color-scheme: dark)",
  "(prefers-contrast: more)",
  "(prefers-reduced-motion: reduce)",
];

const listeners = new Set<() => void>();

function write(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  resolveTheme();
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  listeners.forEach((l) => l());
}

// Re-resolves before notifying, so a caller never reads a stale data-eff-theme whichever
// media listener runs first.
function onSystemChange() {
  resolveTheme();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  if (listeners.size === 0)
    QUERIES.forEach((q) =>
      matchMedia(q).addEventListener("change", onSystemChange),
    );
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0)
      QUERIES.forEach((q) =>
        matchMedia(q).removeEventListener("change", onSystemChange),
      );
  };
}

// A string snapshot keeps useSyncExternalStore's identity check stable.
const snapshot = () => {
  const { theme, effTheme } = document.documentElement.dataset;
  return `${theme ?? "auto"}|${effTheme ?? "light"}`;
};
const serverSnapshot = () => "auto|light";

export function useTheme() {
  const [saved, effective] = useSyncExternalStore(
    subscribe,
    snapshot,
    serverSnapshot,
  ).split("|");
  const theme = saved as Theme;
  const isDark = effective === "dark";
  // Flips the resolved theme, so the first toggle from Auto is an explicit choice.
  const toggle = useCallback(() => write(isDark ? "light" : "dark"), [isDark]);
  return { theme, isDark, toggle, setTheme: write };
}
