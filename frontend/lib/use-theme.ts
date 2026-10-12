"use client";
import { useCallback, useSyncExternalStore } from "react";

// Theme mechanism from the design spec (Foundations §1): localStorage["truex-theme"]
// holds "" | "light" | "dark". Missing defaults to light; an explicit empty
// value is Auto and lets prefers-color-scheme decide.
// State lives in one module-level store so every useTheme() caller stays in sync
// (the topbar toggle and the account menu both flip it).
export type Theme = "" | "light" | "dark";
const KEY = "truex-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

// Inline in <head> so the attribute is set before first paint (no flash).
export const THEME_BOOT_SCRIPT = `var t="light";try{var s=localStorage.getItem("${KEY}");if(s===""||s==="light"||s==="dark")t=s}catch(e){}if(t)document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;`;

const listeners = new Set<() => void>();
let current: Theme | null = null;

function read(): Theme {
  if (current !== null) return current;
  try {
    const saved = localStorage.getItem(KEY);
    current =
      saved === "" || saved === "light" || saved === "dark" ? saved : "light";
  } catch {
    current = "light";
  }
  return current;
}

function write(theme: Theme) {
  current = theme;
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const mq = matchMedia(DARK_QUERY);
  mq.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    mq.removeEventListener("change", listener);
  };
}

// A string snapshot keeps useSyncExternalStore's identity check stable.
const snapshot = () => `${read()}|${matchMedia(DARK_QUERY).matches ? 1 : 0}`;
const serverSnapshot = () => "light|0";

export function useTheme() {
  const [saved, system] = useSyncExternalStore(
    subscribe,
    snapshot,
    serverSnapshot,
  ).split("|");
  const theme = saved as Theme;
  const isDark = theme === "dark" || (!theme && system === "1");
  // Flips the resolved theme, so the first toggle from "system" is explicit.
  const toggle = useCallback(() => write(isDark ? "light" : "dark"), [isDark]);
  return { theme, isDark, toggle, setTheme: write };
}
