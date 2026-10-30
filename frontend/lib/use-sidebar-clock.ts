"use client";
import { useEffect, useState } from "react";

const MINUTE = 60_000;

// The memoized sidebar needs a clock wake even when its props never change:
// times read "12m" and "1h" today. One timer per minute boundary while the tab
// is visible; a hidden tab needs no timer and catches up when shown.
export function useSidebarNow(): number {
  const [now, setNow] = useState(
    () => Math.floor(Date.now() / MINUTE) * MINUTE,
  );
  useEffect(() => {
    let timer: number | undefined;
    const wake = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      const at = Date.now();
      setNow(Math.floor(at / MINUTE) * MINUTE);
      timer = window.setTimeout(wake, MINUTE - (at % MINUTE) + 50);
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
  return now;
}
