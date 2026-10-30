import type { ReactNode } from "react";
import { classes } from "./classes";

// .tx-tile (DESIGN-SPEC 9.8): a glyph held in a squircle. Decorative; the label
// beside it carries the meaning, and the tone mirrors the pill next to it.
export function Tile({
  tone,
  size,
  className,
  children,
}: {
  tone?: "signal" | "ok" | "warn" | "bad" | "inv";
  size?: "sm" | "lg";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={classes(
        "tx-tile",
        tone && `tx-tile-${tone}`,
        size && `tx-tile-${size}`,
        className,
      )}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
