"use client";
import type { CSSProperties, ReactNode } from "react";

// Page frame (Layout & shell §1): one flex row of sidebar, stage and activity panel.
export function Shell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["shell", "layout-main", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

// Clip-reveal panel: the outer aside animates width/opacity while .panel-inner
// keeps its fixed width. Closed panels are aria-hidden and inert so nothing inside
// is tabbable (spec: tabIndex -1 on every control).
export function Panel({
  kind,
  open,
  overlay = false,
  width,
  label,
  className,
  innerClassName,
  children,
}: {
  kind: "sidebar" | "activity";
  open: boolean;
  /** Activity only: floats as a fixed drawer (fitPanel overlay). */
  overlay?: boolean;
  /** Activity only: px width, set inline as --pw. */
  width?: number;
  label?: string;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  const style =
    width != null ? ({ "--pw": `${width}px` } as CSSProperties) : undefined;
  return (
    <aside
      className={[
        "panel",
        kind,
        open && "is-open",
        overlay && "is-overlay",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-label={label}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <div className={["panel-inner", innerClassName].filter(Boolean).join(" ")}>
        {children}
      </div>
    </aside>
  );
}
