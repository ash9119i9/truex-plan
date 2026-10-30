// The application's icons (DESIGN-SPEC 7): one hidden sprite of <symbol>s, each
// drawn on the 24 grid and stroked by .tx-ic, referenced with <use href="#i-…">.
// A new glyph is a design-system request, not a local drawing.
type Source = "rev02" | "sprite" | "interim";

export const GLYPHS = {
  // Drawn in the rev-02 continuous hand (system/icon-foundations.html n-*).
  run: ["rev02", '<path d="M7 6 L17 12 L7 18"/>'],
  agent: [
    "rev02",
    '<path d="M8 2 H16 C21 2 22 3 22 8 V16 C22 21 21 22 16 22 H8 C3 22 2 21 2 16 V8 C2 3 3 2 8 2 Z"/><circle cx="9.5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
  ],
  trace: [
    "rev02",
    '<path d="M6.6 18 H7.5 Q9.5 18 9.5 16 V15.5 Q9.5 13.5 11.5 13.5 H12 L17 9.4"/><circle cx="5" cy="18" r="1.6"/><circle cx="18" cy="8.5" r="1.35" fill="currentColor" stroke="none"/>',
  ],
  tool: [
    "rev02",
    '<path d="M10.742 2.817 Q12 2 13.258 2.817 L18.742 6.383 Q20 7.2 20 8.7 L20 15.3 Q20 16.8 18.742 17.617 L13.258 21.183 Q12 22 10.742 21.183 L5.258 17.617 Q4 16.8 4 15.3 L4 8.7 Q4 7.2 5.258 6.383 Z"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
  ],
  search: [
    "rev02",
    '<path d="M13.1 15.15 A5.6 5.6 0 1 1 15.15 13.1"/><path d="M14.1 14.1 L19.3 19.3"/>',
  ],
  // The current screen sprite (spec 7.3: system/screens/chat.html, then business-activity.html).
  sidebar: [
    "sprite",
    '<path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 3v18"/>',
  ],
  plus: ["sprite", '<path d="M12 5v14M5 12h14"/>'],
  bot: [
    "sprite",
    '<path d="M12 8V4H8M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM2 14h2M20 14h2M9 13v2M15 13v2"/>',
  ],
  panel: [
    "sprite",
    '<path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 3v18"/>',
  ],
  book: [
    "sprite",
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  ],
  "chev-updown": [
    "sprite",
    '<path d="M8 9.5 12 5.5 16 9.5M8 14.5 12 18.5 16 14.5"/>',
  ],
  "chev-down": ["sprite", '<path d="M7 10l5 5 5-5"/>'],
  check: ["sprite", '<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  share: ["sprite", '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v6h14v-6"/>'],
  moon: [
    "sprite",
    '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  ],
  sun: [
    "sprite",
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  ],
  sunrise: [
    "sprite",
    '<path d="M12 3v4M9 5l3-3 3 3M4.9 11.4l1.4 1.4M17.7 12.8l1.4-1.4M2.5 18h2M19.5 18h2M3 21.5h18M8 18a4 4 0 0 1 8 0"/>',
  ],
  sunset: [
    "sprite",
    '<path d="M12 2v5M9 4.5l3 3 3-3M4.9 11.4l1.4 1.4M17.7 12.8l1.4-1.4M2.5 18h2M19.5 18h2M3 21.5h18M8 18a4 4 0 0 1 8 0"/>',
  ],
  copy: ["sprite", '<path d="M9 9h10v10H9zM5 15V5h10"/>'],
  activity: ["sprite", '<path d="M3 12h4l3-8 4 16 3-8h4"/>'],
  list: [
    "sprite",
    '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M4.5 18h1"/>',
  ],
  sigma: ["sprite", '<path d="M18 5H6l6 7-6 7h12"/>'],
  layers: ["sprite", '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>'],
  clock: ["sprite", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  shield: [
    "sprite",
    '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6Z"/><path d="m9 12 2 2 4-4"/>',
  ],
  file: [
    "sprite",
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  ],
  lock: [
    "sprite",
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  ],
  x: ["sprite", '<path d="M6 6l12 12M18 6 6 18"/>'],
  chev: ["sprite", '<path d="m9 6 6 6-6 6"/>'],
  sheet: [
    "sprite",
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  ],
  slides: [
    "sprite",
    '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M12 16v3.5M8.5 19.5h7"/>',
  ],
  code: ["sprite", '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>'],
  text: ["sprite", '<path d="M5 6h14M5 10.5h14M5 15h9M5 19.5h6"/>'],
  discuss: ["sprite", '<path d="M5 5h14v10H10l-4 4v-4H5Z"/>'],
  download: ["sprite", '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>'],
  retry: ["sprite", '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4"/>'],
  pen: [
    "sprite",
    '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  ],
  help: [
    "sprite",
    '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 16.8h.01"/>',
  ],
  compact: ["sprite", '<path d="M4 12h16M9 3.5l3 3 3-3M9 20.5l3-3 3 3"/>'],
  plug: [
    "sprite",
    '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
  ],
  paperclip: [
    "sprite",
    '<path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5"/>',
  ],
  globe: [
    "sprite",
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5Z"/>',
  ],
  alert: [
    "sprite",
    '<path d="M12 4 3 19.5h18Z"/><path d="M12 10v4M12 17h.01"/>',
  ],
  ban: ["sprite", '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>'],
  stop: ["sprite", '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'],
  spark: [
    "sprite",
    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  ],
  user: [
    "sprite",
    '<path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"/>',
  ],
  "chev-l": ["sprite", '<path d="m15 6-6 6 6 6"/>'],
  eye: [
    "sprite",
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  ],
  db: [
    "sprite",
    '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  ],
  chart: [
    "sprite",
    '<path d="M4 20h16"/><path d="M7 16v-5M12 16V7M17 16v-8"/>',
  ],
  hand: [
    "sprite",
    '<path d="M12 3.5v8M8.5 6v6.5M15.5 6v7M5 10v4.5a6.5 6.5 0 0 0 13 0V9"/>',
  ],
  chat: ["sprite", '<path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5Z"/>'],
  out: [
    "sprite",
    '<path d="M5 5v6a4 4 0 0 0 4 4h10"/><path d="m15 11 4 4-4 4"/>',
  ],
  back: [
    "sprite",
    '<path d="M19 5v6a4 4 0 0 1-4 4H5"/><path d="m9 11-4 4 4 4"/>',
  ],
  // Interim: no system drawing yet. Replaced when the full set lands (backlog 13).
  "arrow-up": ["interim", '<path d="M12 19V5M5 12l7-7 7 7"/>'],
  expand: ["interim", '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'],
  shrink: ["interim", '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'],
  folder: [
    "interim",
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ],
} as const satisfies Record<string, readonly [Source, string]>;

export type IconName = keyof typeof GLYPHS;

const SYMBOLS = Object.entries(GLYPHS)
  .map(
    ([name, [, markup]]) =>
      `<symbol id="i-${name}" viewBox="0 0 24 24">${markup}</symbol>`,
  )
  .join("");

// Rendered once, at the top of <body>. The markup is the static table above.
export function IconSprite() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: "absolute", overflow: "hidden" }}
      dangerouslySetInnerHTML={{ __html: SYMBOLS }}
    />
  );
}

// Decorative by default (hidden from assistive technology). Pass `label` when the
// icon is the only content of its control, so it has an accessible name.
export function Icon({
  name,
  size,
  label,
  className,
}: {
  name: IconName;
  size?: "sm" | "lg";
  label?: string;
  className?: string;
}) {
  const classes = ["tx-ic", size && `tx-ic-${size}`, className]
    .filter(Boolean)
    .join(" ");
  const a11y = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true, focusable: "false" as const };
  return (
    <svg className={classes} viewBox="0 0 24 24" {...a11y}>
      <use href={`#i-${name}`} />
    </svg>
  );
}
