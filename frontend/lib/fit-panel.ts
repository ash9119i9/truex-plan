// Session panel fit rules from docs/truex-design-spec.html (Layout & shell §2, app.tsx:1708-1716).
// Pure so it can be unit tested and shared by the resize handler and toggleSidebar.

export const PANEL_W = { min: 360, max: 560 } as const;
export const CHAT_MIN = { min: 480, max: 640 } as const;
export const SIDEBAR_W = 268;
export const GAP = 10;

export type PanelSize = keyof typeof PANEL_W;

export interface Fit {
  /** Session panel width in px (set inline as --pw). */
  width: number;
  /** Whether the sidebar is allowed to be shown alongside the panel. */
  sidebar: boolean;
  /** Whether the session panel floats as a fixed drawer (.is-overlay). */
  overlay: boolean;
}

export function fitPanel(
  vw: number,
  want: number,
  chatMin: number,
  sidebarOpen: boolean,
  panelOpen: boolean,
): Fit {
  const width = Math.min(want, vw - 2 * GAP);
  const chat = vw - 2 * GAP - width - GAP;
  // 1. Phone: one drawer at a time.
  if (vw <= 720) return { width, sidebar: !panelOpen, overlay: false };
  // 2. Panel closed, or ≤900 where CSS turns the panel into a drawer.
  if (!panelOpen || vw <= 900) return { width, sidebar: true, overlay: false };
  // 3. Both fit, or the sidebar isn't requested.
  if (!sidebarOpen || chat - SIDEBAR_W - GAP >= chatMin)
    return { width, sidebar: true, overlay: !sidebarOpen && chat < chatMin };
  // 4. Sidebar yields so the panel can stay docked.
  if (chat >= chatMin) return { width, sidebar: false, overlay: false };
  // 5. Floating drawer.
  return { width, sidebar: false, overlay: true };
}
