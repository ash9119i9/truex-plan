"use client";
import { useRovingFocus } from "@/lib/roving-focus";

// .tx-tabs (DESIGN-SPEC 9.10): views of one object. Automatic activation: moving
// focus selects the tab. The consumer renders the panel with role="tabpanel",
// id={panelId} and aria-labelledby={tabId(idBase, selected)}.
export type TabItem = {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
};

export const tabId = (idBase: string, id: string) => `${idBase}-tab-${id}`;

export function Tabs({
  label,
  idBase,
  panelId,
  items,
  selected,
  onSelect,
}: {
  label: string;
  idBase: string;
  panelId: string;
  items: TabItem[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const index = items.findIndex((item) => item.id === selected);
  const roving = useRovingFocus(
    items,
    index,
    (next) => onSelect(items[next].id),
    "horizontal",
  );
  return (
    <div
      className="tx-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={roving.onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={roving.ref(i)}
          type="button"
          role="tab"
          id={tabId(idBase, item.id)}
          aria-selected={i === index}
          aria-controls={panelId}
          tabIndex={roving.tabIndex(i)}
          disabled={item.disabled}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
          {item.count != null && (
            <>
              {" "}
              <span className="num">{item.count}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
