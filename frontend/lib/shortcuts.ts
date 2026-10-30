"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";

// The application keyboard map (DESIGN-SPEC 11.10). Only chords in this table
// are bound, and aria-keyshortcuts is only ever built from it (ariaKeys), so no
// element can advertise a chord that does nothing. ⌘, and ? join with Settings
// and the shortcuts sheet.
export const SHORTCUTS = {
  new: { key: "j", aria: "Meta+J Control+J" },
  palette: { key: "k", aria: "Meta+K Control+K" },
  sidebar: { key: "b", aria: "Meta+B Control+B" },
  activity: { key: ".", aria: "Meta+. Control+." },
} as const;
export type ShortcutId = keyof typeof SHORTCUTS;
export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>;

export const ariaKeys = (id: ShortcutId) => SHORTCUTS[id].aria;

export type KeyContext = {
  mac: boolean;
  /** Focus is in a text field (input, textarea, contenteditable). */
  inText: boolean;
  /** An open modal: the command palette, or any other dialog. */
  modal: "none" | "palette" | "other";
};

type KeyLike = Pick<
  KeyboardEvent,
  | "key"
  | "metaKey"
  | "ctrlKey"
  | "altKey"
  | "shiftKey"
  | "repeat"
  | "isComposing"
>;

export function matchShortcut(e: KeyLike, ctx: KeyContext): ShortcutId | null {
  // Held keys fire once; ⇧/⌥ chords and AltGr (Ctrl+Alt) are other keys.
  if (e.repeat || e.isComposing || e.altKey || e.shiftKey) return null;
  const primary = ctx.mac ? e.metaKey : e.ctrlKey;
  const other = ctx.mac ? e.ctrlKey : e.metaKey;
  if (primary === other) return null;
  // In a text field only the platform's own modifier counts: on a Mac, Ctrl+K
  // and Ctrl+B edit text (kill line, back one character).
  if (ctx.inText && !primary) return null;
  const pressed = e.key.toLowerCase();
  const id = (Object.keys(SHORTCUTS) as ShortcutId[]).find(
    (name) => SHORTCUTS[name].key === pressed,
  );
  if (!id || ctx.modal === "other") return null;
  // No palette inside a palette: while it is open only its toggle works.
  if (ctx.modal === "palette" && id !== "palette") return null;
  return id;
}

/** Runs the page's handler for a matched chord; returns whether it did. */
export function handleShortcut(
  e: KeyLike & Pick<KeyboardEvent, "preventDefault">,
  ctx: KeyContext,
  handlers: ShortcutHandlers,
): boolean {
  const id = matchShortcut(e, ctx);
  const run = id && handlers[id];
  if (!run) return false;
  e.preventDefault();
  run();
  return true;
}

const isMac = () =>
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

function keyContext(e: KeyboardEvent): KeyContext {
  const target = e.target instanceof HTMLElement ? e.target : null;
  const inText =
    !!target &&
    (target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        !/^(button|checkbox|radio|range|color|file|submit|reset)$/.test(
          target.type,
        )));
  const modal = document.querySelector('[aria-modal="true"], dialog[open]');
  return {
    mac: isMac(),
    inText,
    modal: !modal ? "none" : modal.closest(".pt-palette") ? "palette" : "other",
  };
}

/** Binds this page's chords for as long as the caller is mounted. */
export function useShortcuts(handlers: ShortcutHandlers) {
  // Latest handlers without rebinding the listener on every render.
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key) handleShortcut(e, keyContext(e), ref.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const noSubscribe = () => () => {};

/** The keycap text for a chord: "⌘J" on a Mac, "Ctrl+J" elsewhere. */
export function useKeyLabel(id: ShortcutId) {
  const mac = useSyncExternalStore(noSubscribe, isMac, () => true);
  const letter = SHORTCUTS[id].key.toUpperCase();
  return mac ? `⌘${letter}` : `Ctrl+${letter}`;
}
