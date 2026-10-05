"use client";
import { useCallback, useRef, useState, type SetStateAction } from "react";

// Stream checkpoints must follow applied data, rather than a later React paint.
// All writes go through this setter; the ref also coordinates navigation reads.
export function useAppliedState<T>(initial: T) {
  const [value, publish] = useState(initial);
  const applied = useRef(initial);
  const set = useCallback((update: SetStateAction<T>) => {
    const next =
      typeof update === "function"
        ? (update as (old: T) => T)(applied.current)
        : update;
    if (Object.is(next, applied.current)) return;
    applied.current = next;
    publish(next);
  }, []);
  return [value, set, applied] as const;
}
