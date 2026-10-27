"use client";
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

// Popover (Core components §5): div.popover role="dialog", only while open.
// Closes on outside mousedown and on Escape. Clicks on `ignoreRef` (the toggle
// button) are not "outside", so the toggle's own onClick can close it without a reopen.
export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** Placement class, e.g. "pop-agent" or "pop-user". */
  className?: string;
  children: ReactNode;
  ignoreRef?: RefObject<HTMLElement | null>;
  "aria-label"?: string;
};

export function Popover({
  open,
  onClose,
  className,
  children,
  ignoreRef,
  "aria-label": ariaLabel,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ignoreRef?.current?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, ignoreRef]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={ariaLabel}
      className={className ? `popover ${className}` : "popover"}
    >
      {children}
    </div>
  );
}
