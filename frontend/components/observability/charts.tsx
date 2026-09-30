"use client";
// Tiny chart primitives, styled with the spec's Insights parts (styles/v2/session.css).
// Every chart carries a text alternative; colour is never the only carrier of
// meaning (legends always show values).

export interface Segment {
  key: string;
  label: string;
  value: number;
  // CSS modifier naming the fill, e.g. "seg-new".
  tone: string;
}

// A horizontal part-to-whole bar with a legend that shows every value.
export function StackedBar({
  segments,
  label,
  format,
}: {
  segments: Segment[];
  label: string;
  format: (n: number) => string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  const alt = visible.length
    ? `${label}: ${visible.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`
    : `${label}: none`;
  return (
    <div className="in-meter-block">
      <div className="in-stack" role="img" aria-label={alt}>
        {visible.map((s) => (
          <i
            key={s.key}
            className={`in-seg ${s.tone}`}
            style={{ flexGrow: s.value }}
            title={`${s.label}: ${format(s.value)}`}
          />
        ))}
        {!total && <i className="in-seg is-empty" />}
      </div>
      <ul className="in-keys" aria-hidden="true">
        {segments.map((s) => (
          <li key={s.key} className={s.value ? "" : "is-zero"}>
            <i className={`in-key ${s.tone}`} />
            <span>{s.label}</span>
            <b>{format(s.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A single 0–1 gauge with a plain caption. Spec context meter: warn at 75%,
// critical at 90%.
export function Meter({
  value,
  label,
  caption,
  detail,
  high = 0.75,
  critical = 0.9,
}: {
  value: number;
  label: string;
  caption: string;
  detail?: string | null;
  high?: number;
  critical?: number;
}) {
  const v = Math.min(1, Math.max(0, value));
  const state = v >= critical ? " is-crit" : v >= high ? " is-warn" : "";
  return (
    <div className="in-meter-block">
      <div className="in-meter-head">
        <span>{label}</span>
        <b>{caption}</b>
      </div>
      <div
        className={`in-meter${state}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={[caption, detail].filter(Boolean).join(", ")}
      >
        <span style={{ width: `${v * 100}%` }} />
      </div>
      {detail && <span className="muted sm">{detail}</span>}
    </div>
  );
}

export interface Column {
  id: string;
  // Short axis/tooltip label, e.g. "Turn 3".
  label: string;
  segments: { value: number; tone: string; label: string }[];
  highlight?: boolean;
}

// Vertical columns (optionally stacked), one per turn. SVG so it scales to
// any width; each column has a native tooltip and the whole chart a title.
export function ColumnChart({
  columns,
  title,
  summary,
  format,
  height = 64,
}: {
  columns: Column[];
  title: string;
  summary: string;
  format: (n: number) => string;
  height?: number;
}) {
  const totals = columns.map((c) => c.segments.reduce((s, x) => s + x.value, 0));
  const max = Math.max(1, ...totals);
  const slot = 12,
    bar = 8;
  const width = Math.max(1, columns.length) * slot;
  return (
    <svg
      className="in-cols"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${title}. ${summary}`}
      style={{ height }}
    >
      <title>{`${title}. ${summary}`}</title>
      <line className="in-base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      {columns.map((c, i) => {
        let y = height;
        const x = i * slot + (slot - bar) / 2;
        const tip = `${c.label}: ${format(totals[i])}${
          c.segments.length > 1
            ? ` (${c.segments.map((s) => `${s.label} ${format(s.value)}`).join(", ")})`
            : ""
        }`;
        return (
          <g key={c.id} className={c.highlight ? "is-high" : undefined}>
            <title>{tip}</title>
            {/* Full-height hit target, bigger than the mark. */}
            <rect className="in-hit" x={i * slot} y={0} width={slot} height={height} />
            {c.segments.map((s, j) => {
              const h = (s.value / max) * (height - 2);
              if (h <= 0) return null;
              y -= h;
              // A 1-unit surface gap between stacked segments.
              const gap = j > 0 ? 1 : 0;
              return (
                <rect
                  key={j}
                  className={`in-col ${s.tone}`}
                  x={x}
                  y={y}
                  width={bar}
                  height={Math.max(0.5, h - gap)}
                  rx={1}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
