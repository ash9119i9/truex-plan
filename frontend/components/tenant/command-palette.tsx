"use client";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Keycap } from "@/components/tx/keycap";
import {
  filterPalette,
  firstOption,
  moveOption,
  type PaletteItem,
} from "@/lib/palette";
import { useKeyLabel, type ShortcutId } from "@/lib/shortcuts";

// The command palette (DESIGN-SPEC 10.6), mounted only while open. ⌘K toggles
// it through the page's shortcuts. Esc, the scrim and running an option close
// it and return focus to whatever had it before.
export function CommandPalette({
  items,
  onRun,
  onClose,
}: {
  items: PaletteItem[];
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterPalette(items, query), [items, query]);
  const options = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const [active, setActive] = useState(() => firstOption(options));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A new query selects the first safe option again.
  const [shown, setShown] = useState(options);
  if (shown !== options) {
    setShown(options);
    setActive(firstOption(options));
  }

  useEffect(() => {
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    inputRef.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const optionId = (index: number) => `${id}-o${index}`;
  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: "nearest" });
  });

  const run = (index: number) => {
    const option = options[index];
    if (!option) return;
    onClose();
    onRun(option.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        moveOption(i, e.key === "ArrowDown" ? 1 : -1, options.length),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // The input is the only stop; options are chosen with the arrows.
      e.preventDefault();
    }
  };

  let index = -1;
  return (
    <div
      className="pt-palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="pt-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="pt-palette-input-row">
          <span className="pt-palette-prompt" aria-hidden="true">
            ›
          </span>
          <label className="tx-sr" htmlFor={`${id}-q`}>
            Search conversations and actions
          </label>
          <input
            ref={inputRef}
            id={`${id}-q`}
            className="tx-input pt-palette-input"
            type="search"
            placeholder="Search or jump to…"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={
              active >= 0 && options[active] ? optionId(active) : undefined
            }
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          ref={listRef}
          className="pt-palette-list"
          id={`${id}-list`}
          role="listbox"
          aria-label="Commands"
        >
          {groups.map((g) => (
            <div
              key={g.group}
              className="pt-palette-group-wrap"
              role="group"
              aria-labelledby={`${id}-${g.group}`}
            >
              <div className="pt-palette-group" id={`${id}-${g.group}`}>
                {g.group}
              </div>
              {g.items.map((item) => {
                index += 1;
                const at = index;
                return (
                  <div
                    key={item.id}
                    id={optionId(at)}
                    className="tx-menu-item"
                    role="option"
                    aria-selected={at === active}
                    onMouseMove={() => setActive(at)}
                    onClick={() => run(at)}
                  >
                    <span>
                      {item.label}
                      {item.detail && <small>{item.detail}</small>}
                    </span>
                    {item.shortcut && <ShortcutHint id={item.shortcut} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {options.length === 0 && (
          <div className="pt-palette-empty" aria-live="polite">
            No command matches. Try “new” or a conversation’s title.
          </div>
        )}
        <div className="pt-palette-foot">
          <span>
            <Keycap>↑↓</Keycap> navigate
          </span>
          <span>
            <Keycap>↵</Keycap> run
          </span>
          <span>
            <Keycap>Esc</Keycap> close
          </span>
        </div>
      </div>
    </div>
  );
}

function ShortcutHint({ id }: { id: ShortcutId }) {
  return (
    <span className="pt-pal-keys">
      <Keycap>{useKeyLabel(id)}</Keycap>
    </span>
  );
}
