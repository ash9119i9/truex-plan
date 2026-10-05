"use client";
import { useEffect, useState } from "react";
import { startOfDay } from "./sidebar";

// The memoized sidebar needs a clock wake even when its props never change.
// Calendar midnight handles 23/25-hour DST days; hidden tabs need no timer.
export function useSidebarDay(): number {
  const [day, setDay] = useState(() => startOfDay(new Date()));
  useEffect(() => {
    let timer: number | undefined;
    const wake = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      const now = new Date();
      setDay(startOfDay(now));
      const midnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );
      timer = window.setTimeout(wake, midnight.getTime() - now.getTime() + 50);
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);
  return day;
}
