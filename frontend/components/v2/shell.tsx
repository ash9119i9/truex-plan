"use client";
import type { CSSProperties, ReactNode } from "react";

// The frame that never moves (DESIGN-SPEC 10.1, 11.1): one row of sidebar,
// stage and side panel. `isNew` marks a conversation with no messages yet.
export function Shell({
  isNew = false,
  className,
  children,
}: {
  isNew?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={["cs-shell", isNew && "is-new", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

// A side region. Closed panels are hidden and inert, so nothing inside them is
// tabbable. The sidebar is the cs-sidebar itself; the side panel (the file
// viewer, until the Activity Panel lands) keeps a fixed-width inner box.
export function Panel({
  kind,
  open,
  overlay = false,
  modal = false,
  width,
  label,
  className,
  children,
}: {
  kind: "sidebar" | "activity";
  open: boolean;
  /** Activity only: floats as a fixed drawer (fitPanel overlay). */
  overlay?: boolean;
  /** Floats over the page as a modal dialog (the narrow sidebar drawer). */
  modal?: boolean;
  /** Activity only: px width, set inline as --pw. */
  width?: number;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const style =
    width != null ? ({ "--pw": `${width}px` } as CSSProperties) : undefined;
  return (
    <aside
      className={[
        "panel",
        kind,
        kind === "sidebar" && "cs-sidebar",
        open && "is-open",
        overlay && "is-overlay",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-label={label}
      role={modal && open ? "dialog" : undefined}
      aria-modal={modal && open ? true : undefined}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      {kind === "sidebar" ? (
        children
      ) : (
        <div className="panel-inner">{children}</div>
      )}
    </aside>
  );
}
