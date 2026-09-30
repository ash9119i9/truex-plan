"use client";
import { Fragment, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode, Ref } from "react";

// Floating dock (docs/truex-design-spec.html, Layout & shell §5; source app.tsx:287-340).
// Magnification: BASE 40, PEAK 60, REACH 140, cos² falloff; icon scale 0.9 → 1.25.
const BASE = 40;
const PEAK = 60;
const REACH = 140;

// Dock glyphs, copied from the source dock markup (18px, stroke 1.75).
const DOCK_ICONS = {
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type DockIconName = keyof typeof DOCK_ICONS;

export type DockItem = {
  id: string;
  label: string;
  icon: DockIconName;
  kbd?: string;
  /** Toggle state. Leave undefined for plain actions (no aria-pressed, never active). */
  active?: boolean;
  badge?: boolean;
  onClick: () => void;
  /** Forwarded to the <button>, e.g. so a Popover can ignore clicks on its toggle. */
  buttonRef?: Ref<HTMLButtonElement>;
};

export type FloatingDockProps = {
  items: DockItem[];
  /** Item indexes that start a new group; a separator renders before each (spec: [3, 5]). */
  groups?: number[];
};

const sizeAt = (mx: number, el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  const d = Math.min(Math.abs(mx - (r.left + r.width / 2)), REACH);
  return BASE + (PEAK - BASE) * Math.cos((d / REACH) * (Math.PI / 2)) ** 2;
};

export function FloatingDock({ items, groups = [] }: FloatingDockProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [sizes, setSizes] = useState<number[] | null>(null);
  // Read once on mount (spec); a later OS change applies after remount.
  const reduceMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Each move measures every button's live centre, so sizes track the cursor
  // in the same frame (as in the source's apply(e.clientX)).
  const onMouseMove = (e: MouseEvent) => {
    if (reduceMotion) return;
    const mx = e.clientX;
    setSizes(buttons.current.map((el) => (el ? sizeAt(mx, el) : BASE)));
  };

  return (
    <nav
      className="dock"
      aria-label="Workspace"
      onMouseMove={onMouseMove}
      onMouseLeave={() => setSizes(null)}
    >
      {items.map((item, i) => (
        <Fragment key={item.id}>
          {groups.includes(i) && (
            <span className="dock-sep" aria-hidden="true" />
          )}
          <DockButton
            item={item}
            size={sizes?.[i] ?? BASE}
            register={(el) => {
              buttons.current[i] = el;
              const { buttonRef } = item;
              if (typeof buttonRef === "function") buttonRef(el);
              else if (buttonRef) buttonRef.current = el;
            }}
          />
        </Fragment>
      ))}
    </nav>
  );
}

function DockButton({
  item,
  size,
  register,
}: {
  item: DockItem;
  size: number;
  register: (el: HTMLButtonElement | null) => void;
}) {
  const iconScale = 0.9 + ((size - BASE) / (PEAK - BASE)) * 0.35;
  const toggle = item.active !== undefined;
  return (
    <button
      ref={register}
      type="button"
      className={item.active ? "dock-btn is-active" : "dock-btn"}
      style={{ width: size, height: size }}
      aria-label={item.label}
      aria-pressed={toggle ? item.active : undefined}
      onClick={item.onClick}
    >
      <span className="dock-icon" style={{ transform: `scale(${iconScale})` }}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {DOCK_ICONS[item.icon]}
        </svg>
      </span>
      {item.active && <span className="dock-pip" aria-hidden="true" />}
      {item.badge && <span className="dock-badge" aria-hidden="true" />}
      <span className="dock-tip" role="tooltip">
        {item.label}
        {item.kbd && <kbd>{item.kbd}</kbd>}
      </span>
    </button>
  );
}
