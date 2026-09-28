"use client";
import { useCallback, useEffect, useState } from "react";

// Browser-only preference shared by every trace card on the page. Storage can
// be unavailable (private mode, blocked site data), so every access is guarded.
const KEY = "truex:observability:developer";
const listeners = new Set<(on: boolean) => void>();

function read() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useDeveloperMode() {
  // Read after mount so server and client render match.
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(read());
    listeners.add(setOn);
    return () => {
      listeners.delete(setOn);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    try {
      if (next) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      // The toggle still works for this page view.
    }
    for (const l of listeners) l(next);
  }, []);
  return [on, set] as const;
}
