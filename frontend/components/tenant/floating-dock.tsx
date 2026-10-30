"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  DOCK,
  dockOpen,
  keySize,
  magnifies,
  restCentres,
  riseBand,
  settle,
  spring,
  type Spring,
} from "@/lib/dock";
import { ariaKeys, useKeyLabel, type ShortcutId } from "@/lib/shortcuts";
import { Icon, type IconName } from "@/components/tx/icon";
import { Menu, type MenuEntry } from "@/components/tx/menu";

// The workspace dock (DESIGN-SPEC 11.9): circular keys centred at the bottom of
// the stage. It rests stowed below the edge and rises when the pointer reaches
// the bottom or a key takes focus. On touch it is static and always visible.
// The Activity key shows only where the Activity Panel exists (an open
// conversation): a key for a region that isn't there is a dead instrument.

type Key = {
  label: string;
  icon: IconName;
  shortcut?: ShortcutId;
  pressed?: boolean;
  onPress: () => void;
  /** The key opens this menu instead of pressing (the Agent key). */
  menu?: DockMenu;
};
type DockMenu = { items: MenuEntry[]; onSelect: (id: string) => void };

export function FloatingDock({
  sidebarOpen,
  onSidebar,
  onSearch,
  onNew,
  onAgent,
  onAccount,
  agentMenu,
  onUpChange,
  activityOpen,
  onActivity,
}: {
  sidebarOpen: boolean;
  /** The Activity Panel exists here (an open conversation) and its state. */
  activityOpen?: boolean;
  onActivity?: () => void;
  onSidebar: () => void;
  onSearch: () => void;
  onNew: () => void;
  onAgent: () => void;
  onAccount: () => void;
  /** The Agent key's menu: a few agents, Browse all agents, Create agent. */
  agentMenu?: DockMenu;
  /** The dock rose or stowed (the composer reserves its height while it is up). */
  onUpChange?: (up: boolean) => void;
}) {
  const keys: Key[] = [
    {
      label: "Sidebar",
      icon: "sidebar",
      shortcut: "sidebar",
      pressed: sidebarOpen,
      onPress: onSidebar,
    },
    { label: "Search", icon: "search", shortcut: "palette", onPress: onSearch },
    { label: "New chat", icon: "plus", shortcut: "new", onPress: onNew },
    { label: "Agent", icon: "bot", onPress: onAgent, menu: agentMenu },
    ...(onActivity
      ? [
          {
            label: "Activity",
            icon: "activity" as const,
            shortcut: "activity" as const,
            pressed: !!activityOpen,
            onPress: onActivity,
          },
        ]
      : []),
    { label: "Account", icon: "user", onPress: onAccount },
  ];
  const nav = useRef<HTMLElement>(null);
  const up = useDockStow(nav, onUpChange);
  useMagnification(nav);
  return (
    <nav
      ref={nav}
      className={up ? "cs-dock" : "cs-dock is-stowed"}
      aria-label="Workspace dock"
    >
      {keys.map((key) =>
        key.menu ? (
          <DockMenuKey key={key.label} {...key} menu={key.menu} />
        ) : (
          <DockKey key={key.label} {...key} />
        ),
      )}
    </nav>
  );
}

function DockKey({ label, icon, shortcut, pressed, onPress }: Key) {
  return (
    <button
      type="button"
      className="cs-dock-btn"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : undefined}
      onClick={onPress}
    >
      <span className="cs-dock-ic">
        <Icon name={icon} className="cs-dock-glyph" />
      </span>
      <span className="cs-dock-tip" role="tooltip">
        {label}
        {shortcut && (
          <>
            {" "}
            <KeyLabel id={shortcut} />
          </>
        )}
      </span>
    </button>
  );
}

// A key that opens a menu above the dock (the Agent key). The menu is inside
// the dock, so the dock stays up while it is open.
function DockMenuKey({ label, icon, menu }: Key & { menu: DockMenu }) {
  return (
    <Menu
      label="Agents"
      heading="Agents"
      items={menu.items}
      onSelect={menu.onSelect}
      className="cs-dock-menu-key"
      panelClassName="cs-dock-menu"
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          className="cs-dock-btn"
          aria-label={label}
          {...props}
        >
          <span className="cs-dock-ic">
            <Icon name={icon} className="cs-dock-glyph" />
          </span>
          <span className="cs-dock-tip" role="tooltip">
            {label}
          </span>
        </button>
      )}
    />
  );
}

function KeyLabel({ id }: { id: ShortcutId }) {
  return <kbd className="tx-kbd">{useKeyLabel(id)}</kbd>;
}

const FINE = "(hover: hover) and (pointer: fine)";
const REDUCED = "(prefers-reduced-motion: reduce)";

// Rise and stow, with the hysteresis in dockOpen. Only fine pointers stow it;
// on touch it stays up and CSS keeps it static.
function useDockStow(
  nav: RefObject<HTMLElement | null>,
  onUpChange?: (up: boolean) => void,
) {
  const [up, setUp] = useState(false);
  const report = useRef(onUpChange);
  report.current = onUpChange;
  useEffect(() => {
    const dock = nav.current;
    if (!dock) return;
    const fine = matchMedia(FINE);
    let open = false;
    let fromBottom = Infinity;
    const set = (next: boolean) => {
      if (open === next) return;
      open = next;
      setUp(next);
      report.current?.(next);
    };
    // Distances are measured up from the stage's bottom edge, not the
    // viewport's: the shell's gap below the stage is only a few px, so a
    // viewport band fell almost entirely outside the stage. The gap itself is
    // below that edge (negative), so it still raises the dock.
    const floor = () =>
      dock.closest(".cs-stage")?.getBoundingClientRect().bottom ??
      window.innerHeight;
    // The stage bottom to the dock's resting top; the rise transform is
    // backed out so the line doesn't drift mid-rise.
    const footprint = () => {
      const t = getComputedStyle(dock).transform;
      const shift = t === "none" ? 0 : new DOMMatrix(t).m42;
      return floor() - (dock.getBoundingClientRect().top - shift);
    };
    const reach = () => footprint() + DOCK.slack;
    // The empty room the dock will fill: its footprint, cut off at the lowest
    // content above it (the composer in its row in an open chat, the centred
    // hero in a new one), so reaching for the composer never raises it.
    const rise = () => {
      const stage = dock.closest(".cs-stage");
      const above = [
        ...(dock.parentElement?.children ?? []),
        ...(stage?.querySelectorAll(".cs-hero-in") ?? []),
      ];
      let content = -Infinity;
      for (const el of above)
        if (el !== dock)
          content = Math.max(content, el.getBoundingClientRect().bottom);
      return riseBand(footprint(), floor() - content);
    };
    // Only keyboard focus holds the dock up. A clicked key keeps focus too,
    // and that must not pin the dock after the pointer leaves; the browser's
    // :focus-visible tells the two apart.
    const keyboard = (el: Element | null) =>
      !!el && dock.contains(el) && el.matches(":focus-visible");
    // An open menu (the Agent key's) holds the dock up too.
    const inside = () =>
      keyboard(document.activeElement) || !!dock.querySelector('[role="menu"]');
    const move = (e: MouseEvent) => {
      if (!fine.matches) return;
      fromBottom = floor() - e.clientY;
      set(dockOpen(open, fromBottom, reach(), inside(), open ? 0 : rise()));
    };
    const leave = () => {
      if (fine.matches && !inside()) set(false);
    };
    const focusIn = (e: FocusEvent) => {
      if (keyboard(e.target as Element | null)) set(true);
    };
    const focusOut = (e: FocusEvent) => {
      if (dock.contains(e.relatedTarget as Node | null)) return;
      if (fine.matches && fromBottom >= reach() && !inside()) set(false);
    };
    const pointerChange = () => set(!fine.matches);
    pointerChange();
    window.addEventListener("mousemove", move, { passive: true });
    document.documentElement.addEventListener("mouseleave", leave);
    dock.addEventListener("focusin", focusIn);
    dock.addEventListener("focusout", focusOut);
    fine.addEventListener("change", pointerChange);
    return () => {
      window.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      dock.removeEventListener("focusin", focusIn);
      dock.removeEventListener("focusout", focusOut);
      fine.removeEventListener("change", pointerChange);
      report.current?.(false);
    };
  }, [nav]);
  return up;
}

// Key magnification: sizes are written straight to the keys each frame, so the
// pointer never causes a React render.
function useMagnification(nav: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dock = nav.current;
    if (!dock) return;
    const fine = matchMedia(FINE);
    const reduced = matchMedia(REDUCED);
    const keys = () =>
      Array.from(dock.querySelectorAll<HTMLElement>(".cs-dock-btn"));
    const px: Spring = { x: 0, v: 0, t: 0 };
    const on: Spring = { x: 0, v: 0, t: 0 };
    let rest: number[] = [];
    let centre = 0;
    let raf = 0;
    let last = 0;

    const measure = () => {
      const box = dock.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(dock).columnGap) || 0;
      centre = box.left + box.width / 2;
      rest = restCentres(keys().length, gap);
    };
    const paint = (clear: boolean) =>
      keys().forEach((key, i) => {
        const size = clear ? null : keySize(px.x, rest[i], on.x);
        key.style.width = size === null ? "" : `${size}px`;
        key.style.height = size === null ? "" : `${size}px`;
        const glyph = key.firstElementChild as HTMLElement | null;
        if (glyph)
          glyph.style.transform =
            size === null
              ? ""
              : `scale(${1 + (size / DOCK.base - 1) * DOCK.glyph})`;
      });
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.064) : 1 / 60;
      last = now;
      spring(px, DOCK.wPointer, dt);
      spring(on, DOCK.wPresence, dt);
      if (settle(px, 0.05) && settle(on, 0.001)) {
        px.x = px.t;
        px.v = 0;
        on.x = on.t;
        on.v = 0;
      }
      if (on.x === 0 && on.t === 0) {
        paint(true);
        raf = 0;
        last = 0;
        return;
      }
      paint(false);
      raf = px.v === 0 && on.v === 0 ? 0 : requestAnimationFrame(tick);
      if (!raf) last = 0;
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      Object.assign(px, { x: 0, v: 0, t: 0 });
      Object.assign(on, { x: 0, v: 0, t: 0 });
      paint(true);
    };
    const enabled = () =>
      magnifies({ reduced: reduced.matches, fine: fine.matches });
    const overMenu = (e: MouseEvent) =>
      !!(e.target as Element | null)?.closest?.(".tx-menu");
    const enter = (e: MouseEvent) => {
      if (!enabled() || overMenu(e)) return;
      measure();
      // Arriving from nothing: start the swell where the pointer is.
      if (on.x < 0.02) Object.assign(px, { x: e.clientX - centre, v: 0 });
      px.t = e.clientX - centre;
      on.t = 1;
      wake();
    };
    const move = (e: MouseEvent) => {
      if (!enabled()) return;
      // Over the open menu the keys settle back, as if the pointer left.
      if (overMenu(e)) {
        if (on.t !== 0) leave();
        return;
      }
      if (on.t !== 1) {
        measure();
        on.t = 1;
      }
      px.t = e.clientX - centre;
      wake();
    };
    // The pointer's last position is kept, so the swell sinks where it stood.
    const leave = () => {
      on.t = 0;
      wake();
    };
    dock.addEventListener("mouseenter", enter);
    dock.addEventListener("mousemove", move);
    dock.addEventListener("mouseleave", leave);
    window.addEventListener("resize", stop);
    reduced.addEventListener("change", stop);
    fine.addEventListener("change", stop);
    return () => {
      stop();
      dock.removeEventListener("mouseenter", enter);
      dock.removeEventListener("mousemove", move);
      dock.removeEventListener("mouseleave", leave);
      window.removeEventListener("resize", stop);
      reduced.removeEventListener("change", stop);
      fine.removeEventListener("change", stop);
    };
  }, [nav]);
}
