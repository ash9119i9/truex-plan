"use client";
import { StreamIcon } from "./stream-icon";

// A finished thinking step in the work log (wireframe §1 board 2, pin 3):
// "Thought for 4s" as a disclosure that opens the summary in serif italic,
// with raw reasoning below it when the runtime sent any. While thinking
// streams, the log shows the shimmer live row instead (runtime-item.tsx).
export function ThinkingBlock({
  title,
  summary,
  raw,
}: {
  title: string;
  summary: string;
  raw?: string;
}) {
  if (!summary && !raw) return <b>{title}</b>;
  return (
    <details className="st-think">
      <summary>
        <b>{title}</b>
        <StreamIcon name="chevd" sm />
      </summary>
      {summary && <p>{summary}</p>}
      {raw && <p>{raw}</p>}
    </details>
  );
}
