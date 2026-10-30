import type { CSSProperties } from "react";
import { classes } from "./classes";

// .tx-meter (DESIGN-SPEC 9.16). Write the value as text nearby too; the meter
// itself is never the only place a number appears.
export function Meter({
  label,
  value,
  max = 100,
  tone,
  size,
  valueText,
}: {
  label: string;
  value: number;
  max?: number;
  tone?: "signal" | "ok" | "warn" | "bad";
  size?: "lg";
  valueText?: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <span
      className={classes(
        "tx-meter",
        tone && `tx-meter-${tone}`,
        size && `tx-meter-${size}`,
      )}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      style={{ "--tx-p": Math.round(percent) } as CSSProperties}
    >
      <i />
    </span>
  );
}
