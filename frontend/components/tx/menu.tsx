"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRovingFocus } from "@/lib/roving-focus";
import { classes } from "./classes";
import { Icon, type IconName } from "./icon";

// .tx-menu (DESIGN-SPEC 9.13): real buttons; ↑/↓/Home/End wrap; Esc closes and
// returns focus to the trigger; Tab and an outside pointer-down close it. Items
// with `checked` are a single choice (menuitemradio). Destructive items are never
// the first selection. Positioning is the consumer's (className / panelClassName).
export type MenuItem = {
  id: string;
  label: string;
  icon?: IconName;
  detail?: string;
  kbd?: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** Decorative leading content in place of an icon (an avatar). */
  lead?: ReactNode;
};
export type MenuEntry = MenuItem | "separator";

export type TriggerProps = {
  ref: (node: HTMLElement | null) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls"?: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

const actionsOf = (items: MenuEntry[]) =>
  items.filter((item): item is MenuItem => item !== "separator");

export function MenuPanel({
  id,
  label,
  heading,
  items,
  active,
  itemRef,
  onKeyDown,
  onSelect,
  className,
}: {
  id: string;
  label: string;
  /** A visible header row (.tx-menu-h). */
  heading?: string;
  items: MenuEntry[];
  active: number;
  itemRef: (index: number) => (node: HTMLElement | null) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onSelect: (id: string) => void;
  className?: string;
}) {
  let index = -1;
  return (
    <div
      className={classes("tx-menu", className)}
      id={id}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {heading && <div className="tx-menu-h">{heading}</div>}
      {items.map((item, i) => {
        if (item === "separator")
          return (
            <div key={`sep-${i}`} className="tx-menu-sep" role="separator" />
          );
        index += 1;
        const radio = item.checked !== undefined;
        return (
          <button
            key={item.id}
            ref={itemRef(index)}
            type="button"
            className={classes("tx-menu-item", item.danger && "tx-menu-danger")}
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? item.checked : undefined}
            tabIndex={index === active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onSelect(item.id)}
          >
            {item.lead ?? (item.icon && <Icon name={item.icon} />)}
            <span>
              {item.label}
              {item.detail && <small>{item.detail}</small>}
            </span>
            {item.kbd && <kbd className="tx-kbd">{item.kbd}</kbd>}
            {item.checked && <Icon name="check" />}
          </button>
        );
      })}
    </div>
  );
}

export function Menu({
  label,
  heading,
  trigger,
  items,
  onSelect,
  className,
  panelClassName,
}: {
  label: string;
  heading?: string;
  trigger: (props: TriggerProps) => ReactNode;
  items: MenuEntry[];
  onSelect: (id: string) => void;
  className?: string;
  panelClassName?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const triggerNode = useRef<HTMLElement | null>(null);
  const actions = actionsOf(items);
  const roving = useRovingFocus(actions, active, setActive, "vertical");

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerNode.current?.focus();
  };
  const show = (at: number) => {
    setActive(at);
    setOpen(true);
  };
  const first = () => {
    const checked = actions.findIndex((item) => item.checked);
    return checked >= 0 ? checked : 0;
  };

  useEffect(() => {
    if (!open) return;
    roving.focus(active);
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
    // Focus moves once when the menu opens; arrows move it after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className={className} ref={wrap}>
      {trigger({
        ref: (node) => {
          triggerNode.current = node;
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
        onClick: () => (open ? close(false) : show(first())),
        onKeyDown: (event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          show(event.key === "ArrowDown" ? first() : actions.length - 1);
        },
      })}
      {open && (
        <MenuPanel
          id={id}
          label={label}
          heading={heading}
          items={items}
          active={active}
          className={panelClassName}
          itemRef={roving.ref}
          onSelect={(item) => {
            close(true);
            onSelect(item);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "Tab") {
              close(false);
            } else {
              roving.onKeyDown(event);
            }
          }}
        />
      )}
    </div>
  );
}
