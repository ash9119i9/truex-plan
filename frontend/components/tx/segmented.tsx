"use client";
import { useRovingFocus } from "@/lib/roving-focus";
import { classes } from "./classes";

// .tx-seg (DESIGN-SPEC 9.9): 2–4 exclusive options, all visible, as a roving
// radiogroup (D14). Five or more is a menu.
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size,
}: {
  label: string;
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm";
}) {
  const index = options.findIndex((option) => option.value === value);
  const roving = useRovingFocus(
    options,
    index,
    (next) => onChange(options[next].value),
    "both",
  );
  return (
    <div
      className={classes("tx-seg", size && `tx-seg-${size}`)}
      role="radiogroup"
      aria-label={label}
      onKeyDown={roving.onKeyDown}
    >
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={roving.ref(i)}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={roving.tabIndex(i)}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
