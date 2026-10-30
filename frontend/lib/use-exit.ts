"use client";
import { useEffect, useState } from "react";

const reduced = () =>
  typeof document !== "undefined" &&
  document.documentElement.dataset.effMotion === "reduce";

/**
 * Whether a closing element should still be mounted: true while `open`, and
 * for `ms` after it turns false so its exit transition can play. Reduced
 * motion unmounts at once.
 */
export function useExit(open: boolean, ms: number): boolean {
  const [kept, setKept] = useState(open);
  // Opening keeps it from the same render, not one effect later.
  if (open && !kept) setKept(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setKept(false), reduced() ? 0 : ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return open || kept;
}
