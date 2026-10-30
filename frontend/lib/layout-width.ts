"use client";
import { useEffect, useState } from "react";

// Where the chat shell folds (DESIGN-SPEC 11.11), in 100%-text CSS pixels.
// The CSS twins are `@container app (max-width: 55rem / 67.5rem)`: container
// queries resolve rem against the root font, so both sides move with the
// text size (law 10: at 200% a 1440px window has the room of 720px).
export const FOLD = {
  /** At or below this the sidebar is a drawer. */
  sidebar: 880,
  /** At or below this the Activity Panel floats instead of docking. */
  activity: 1080,
} as const;

const BASE_PX = 16;

/** The window's width measured in pixels of 100% text. */
export function layoutWidth(innerWidth: number, rootFontPx: number): number {
  if (!Number.isFinite(rootFontPx) || rootFontPx <= 0) return innerWidth;
  return (innerWidth * BASE_PX) / rootFontPx;
}

function measure(): number {
  const root = document.documentElement;
  return layoutWidth(
    window.innerWidth,
    parseFloat(getComputedStyle(root).fontSize),
  );
}

/**
 * The layout width, kept current as the window resizes or the text size
 * changes (the resolver writes `data-textsize` on <html>). Server renders
 * assume a wide desktop window.
 */
export function useLayoutWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : measure(),
  );
  useEffect(() => {
    const update = () => setWidth(measure());
    update();
    window.addEventListener("resize", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-textsize", "style"],
    });
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, []);
  return width;
}
