"use client";
import { useSyncExternalStore } from "react";

export type Appearance = "light" | "dark";

// What the page looks like: the theme attribute the app's styles follow, or the
// system setting when there is none. Embedded content (visuals, apps) follows
// this rather than stored state, so it always matches what the reader sees.
export function resolveAppearance(
  attribute: string | null | undefined,
  systemDark: boolean,
): Appearance {
  if (attribute === "light" || attribute === "dark") return attribute;
  return systemDark ? "dark" : "light";
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const query = matchMedia(DARK_QUERY);
  query.addEventListener("change", listener);
  return () => {
    observer.disconnect();
    query.removeEventListener("change", listener);
  };
}

const snapshot = (): Appearance =>
  resolveAppearance(
    document.documentElement.dataset.theme,
    matchMedia(DARK_QUERY).matches,
  );

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, snapshot, () => "light");
}
