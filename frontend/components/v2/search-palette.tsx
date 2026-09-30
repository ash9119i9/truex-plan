"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icon";

export interface SearchItem {
  id: string;
  title: string;
  time: string;
}

// Search palette (Core components §6).
export function SearchPalette({
  open,
  onClose,
  items,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  items: SearchItem[];
  /** Called with the chosen id; the palette closes itself afterwards. */
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  // On open: reset query and index, focus the input after 10ms.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setIndex(0);
    const t = setTimeout(() => input.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const needle = q.toLowerCase();
  const results = items.filter((i) => i.title.toLowerCase().includes(needle));
  const active = Math.min(index, Math.max(results.length - 1, 0));

  function pick(id: string) {
    onPick(id);
    onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(active + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      const hit = results[active];
      if (hit) {
        e.preventDefault();
        pick(hit.id);
      }
    }
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              results[active] ? `${listId}-${active}` : undefined
            }
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" id={listId} role="listbox" aria-label="Conversations">
          {results.length === 0 ? (
            <div className="muted sm pad">No matches for “{q}”</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "menu-item is-active" : "menu-item"}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(r.id)}
              >
                <Icon name="doc" size={15} />
                <span className="grow">{r.title}</span>
                <span className="muted sm mono">{r.time}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
