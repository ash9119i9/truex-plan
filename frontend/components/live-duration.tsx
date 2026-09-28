"use client";
import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { durationParts, formatDuration } from "@/lib/subagents";
import { cn } from "@/lib/utils";

const twoDigits = { minimumIntegerDigits: 2 };
// The tens digit of minutes and seconds never passes 5, so 0:59 rolls to 1:00.
const sixty = { 1: { max: 5 } };

// An elapsed time (m:ss, or h:mm:ss) whose digits roll as it ticks. Screen
// readers get the plain time once; the rolling digits are hidden from them.
export function LiveDuration({
  ms,
  className,
}: {
  ms: number;
  className?: string;
}) {
  const { h, m, s } = durationParts(ms);
  return (
    <time
      className={cn("live-duration", className)}
      dateTime={`PT${h}H${m}M${s}S`}
    >
      <span className="visually-hidden">{formatDuration(ms)}</span>
      <NumberFlowGroup>
        <span className="live-duration-digits" aria-hidden="true">
          {h > 0 && (
            <>
              <NumberFlow value={h} trend={1} />:
            </>
          )}
          <NumberFlow
            value={m}
            trend={1}
            digits={h > 0 ? sixty : undefined}
            format={h > 0 ? twoDigits : undefined}
          />
          :
          <NumberFlow value={s} trend={1} digits={sixty} format={twoDigits} />
        </span>
      </NumberFlowGroup>
    </time>
  );
}

/**
 * Rolling digits by Number Flow (https://number-flow.barvian.me), as shown in
 * Skiper 37 AnimatedNumber by Skiper UI. Author: @gurvinder-singh02 —
 * https://gxuri.me. Free version; attribution to Skiper UI is required.
 */
