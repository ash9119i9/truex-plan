// Icons for the observability slice, drawn from the r2 wireframe's symbol set
// (convo-v2-wireframe-r2.html). Sized by the scoped .ic / .ic.sm rules in
// styles/v2/r2-insights.css; the attributes are fallbacks.
import type { ReactNode } from "react";

const PATHS = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  sigma: <path d="M18 5H6l6 7-6 7h12" />,
  spark: (
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  chevd: <path d="m6 9 6 6 6-6" />,
  chev: <path d="m9 6 6 6-6 6" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  check: <path d="m5 12 5 5 9-10" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M4.5 18h1" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  retry: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  term: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
} satisfies Record<string, ReactNode>;

export type ObIconName = keyof typeof PATHS;

export function ObIcon({
  name,
  sm,
  className,
}: {
  name: ObIconName;
  sm?: boolean;
  className?: string;
}) {
  const size = sm ? 13 : 16;
  return (
    <svg
      className={["ic", sm && "sm", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
