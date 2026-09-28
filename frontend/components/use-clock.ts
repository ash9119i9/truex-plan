"use client";
import { useEffect, useState } from "react";

// One shared one-second clock for every helper timer. It only runs while
// something is active, so an idle chat never re-renders on a timer.
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: (now: number) => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    const now = Date.now();
    for (const l of listeners) l(now);
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return subscribe(setNow);
  }, [active]);
  return now;
}
