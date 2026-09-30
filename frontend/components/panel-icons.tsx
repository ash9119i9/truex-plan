import type { ReactNode } from "react";

// The wireframe's panel icon symbols (convo-v2-wireframe-r2.html), drawn with
// its .ic / .ic.sm classes so size and stroke come from r2-panel.css.
const SHAPES = {
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3 6" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M4.5 18h1" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  sigma: <path d="M18 5H6l6 7-6 7h12" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />,
  chev: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12 5 5 9-10" />,
  alert: (
    <>
      <path d="M12 3 2 20h20Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  steer: <path d="M4 17c5 0 6-10 12-10h4M17 4l3 3-3 3" />,
  brain: (
    <path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 13a3 3 0 0 0 2 2.8V17a3 3 0 0 0 6 0V4.8A3 3 0 0 0 9 4ZM15 4a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 5.5 3 3 0 0 1-2 2.8V17a3 3 0 0 1-6 0" />
  ),
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
} satisfies Record<string, ReactNode>;

export type PanelIconName = keyof typeof SHAPES;

export function PanelIcon({
  name,
  sm = true,
  className,
}: {
  name: PanelIconName;
  sm?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`ic${sm ? " sm" : ""}${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {SHAPES[name]}
    </svg>
  );
}
