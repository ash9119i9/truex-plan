import type { ReactNode } from "react";

// Session chrome glyphs, copied from the r2 wireframe's <symbol> sprite
// (convo-v2-wireframe-r2.html). Sized by the .ic / .ic.sm rules in r2-chrome.css.
const GLYPHS = {
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="4" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </>
  ),
  chevd: <path d="m6 9 6 6 6-6" />,
  chev: <path d="m9 6 6 6-6 6" />,
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  plug: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v4" />,
  retry: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />,
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
  plus: <path d="M12 5v14M5 12h14" />,
  spark: (
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  term: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M4.5 18h1" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type ChIconName = keyof typeof GLYPHS;

export function ChIcon({ name, sm = false }: { name: ChIconName; sm?: boolean }) {
  return (
    <svg className={sm ? "ic sm" : "ic"} viewBox="0 0 24 24" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}
