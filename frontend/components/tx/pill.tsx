import type { ReactNode } from "react";
import { classes } from "./classes";

// .tx-pill (DESIGN-SPEC 9.6). A status pill carries a glyph and a word: the glyph
// names the state, the word confirms it, the tint only repeats it.
type Shared = { size?: "sm"; className?: string; children: ReactNode };
export type PillProps =
  | (Shared & { tone: "ok" | "warn" | "bad" | "live"; glyph: ReactNode })
  | (Shared & { tone?: "inv" | "line"; glyph?: ReactNode });

export function Pill({ tone, size, glyph, className, children }: PillProps) {
  return (
    <span
      className={classes(
        "tx-pill",
        tone && `tx-pill-${tone}`,
        size && `tx-pill-${size}`,
        className,
      )}
    >
      {glyph != null && <span aria-hidden="true">{glyph}</span>}
      {children}
    </span>
  );
}
