// Stream icon set, copied from the <symbol> sprite in convo-v2-wireframe-r2.html.
// Rendered as .ic / .ic.sm (r2-stream.css). Always decorative: the text beside
// each icon carries the meaning.
const SHAPES = {
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 13a3 3 0 0 0 2 2.8V17a3 3 0 0 0 6 0V4.8A3 3 0 0 0 9 4ZM15 4a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 5.5 3 3 0 0 1-2 2.8V17a3 3 0 0 1-6 0" />,
  term: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3 6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M4.5 18h1" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  check: <path d="m5 12 5 5 9-10" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  steer: <path d="M4 17c5 0 6-10 12-10h4M17 4l3 3-3 3" />,
  slash: <path d="M15 4 9 20" />,
  chev: <path d="m9 6 6 6-6 6" />,
  chevd: <path d="m6 9 6 6 6-6" />,
  retry: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="4" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
} as const;

export type StreamIconName = keyof typeof SHAPES;

export function StreamIcon({
  name,
  sm,
  className,
}: {
  name: StreamIconName;
  sm?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={["ic", sm && "sm", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
