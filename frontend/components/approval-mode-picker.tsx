"use client";
import { useEffect, useId, useRef, useState } from "react";
import { RqIcon, type RqIconName } from "./v2/rq-icon";
import type { ApprovalMode } from "../../shared/contracts";
import { MODE_FOOTNOTE, type ModePicker } from "@/lib/approval-mode";

// Approval mode chip and menu (wireframe r2 §2, board 3). The page renders
// this only when the flag is on (modePicker returns null otherwise), so the
// control is hidden entirely when the feature is off.
const ICONS: Record<ApprovalMode, RqIconName> = {
  ask: "shield",
  readOnly: "eye",
  auto: "spark",
};

export function ApprovalModePicker({
  picker,
  onChange,
  disabled = false,
  errorId,
}: {
  picker: ModePicker;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
  /** Id of an error message shown elsewhere in the composer. */
  errorId?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const current =
    picker.options.find((o) => o.value === picker.selected) ||
    picker.options[0];

  useEffect(() => {
    if (!open) return;
    // Focus the checked item when the menu opens.
    const at = Math.max(
      0,
      picker.options.findIndex((o) => o.value === picker.selected),
    );
    items.current[at]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, picker.options, picker.selected]);

  function close(refocus = true) {
    setOpen(false);
    if (refocus) toggle.current?.focus();
  }
  function move(from: number, by: number) {
    const n = picker.options.length;
    items.current[(from + by + n) % n]?.focus();
  }

  return (
    <span className="rq-mode" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="rq-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-describedby={`${id}-help${errorId ? ` ${errorId}` : ""}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <RqIcon name={ICONS[current.value]} size="sm" />
        <span className="sr-only">Approval mode: </span>
        {current.label}
        <RqIcon name="chevd" size="sm" />
      </button>
      <span id={`${id}-help`} className="sr-only">
        {current.description}
      </span>
      {open && (
        <div
          id={`${id}-menu`}
          className="rq-menu"
          role="menu"
          aria-label="Approval mode"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Tab") close(false);
          }}
        >
          <div className="rq-menu-h" aria-hidden="true">
            <RqIcon name="shield" size="sm" />
            Approval mode<code>flag</code>
          </div>
          {picker.options.map((o, i) => {
            const on = o.value === picker.selected;
            return (
              <button
                key={o.value}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={`rq-mi${on ? " on" : ""}${o.value === "auto" ? " warn" : ""}`}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    move(i, e.key === "ArrowDown" ? 1 : -1);
                  }
                }}
                onClick={() => {
                  if (!on) onChange(o.value);
                  close();
                }}
              >
                <span aria-hidden="true">
                  <RqIcon name={ICONS[o.value]} size="sm" />
                </span>
                <div>
                  <b>{o.label}</b>
                  <small>{o.description}</small>
                </div>
                {on ? <RqIcon name="check" size="sm" className="chk" /> : <span />}
              </button>
            );
          })}
          <div className="rq-menu-f">
            <RqIcon name="lock" size="sm" />
            {MODE_FOOTNOTE}
          </div>
        </div>
      )}
    </span>
  );
}
