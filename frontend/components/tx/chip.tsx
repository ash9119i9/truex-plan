"use client";
import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { classes } from "./classes";
import { Icon } from "./icon";

// .tx-chip (DESIGN-SPEC 9.7): pick a value. Pressed state is a signal job.
export function Chip({
  pressed,
  className,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-pressed"> & {
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={classes("tx-chip", className)}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  );
}

const COPIED_MS = 1500;

// .tx-chip-ref: a reference (trace or request id) that copies itself on press.
export function RefChip({
  value,
  label,
  copyIcon = false,
}: {
  value: string;
  label: string;
  // Shows the copy glyph after the value (the trace chip, spec 14.3).
  copyIcon?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={classes("tx-chip tx-chip-ref", copied && "is-copied")}
      aria-label={`Copy ${label} ${value}`}
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {value}
      {copyIcon && <Icon name="copy" size="sm" />}
    </button>
  );
}
