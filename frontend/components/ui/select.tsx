"use client";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Check } from "lucide-react";
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        className="select-trigger"
        aria-label={placeholder}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="select-content" position="popper">
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                className="select-item"
                key={o.value}
                value={o.value}
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={14} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
