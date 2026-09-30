"use client";
import { useId } from "react";
import { Icon } from "./v2/icon";
import type { ApprovalMode } from "../../shared/contracts";
import type { ModePicker } from "@/lib/approval-mode";

// Alpha: how this chat handles questions and tool approvals. A native select
// keeps it keyboard operable and uses the platform picker on phones.
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
  const current =
    picker.options.find((o) => o.value === picker.selected) ||
    picker.options[0];
  return (
    <span className="approval-mode">
      <label htmlFor={`${id}-select`} className="visually-hidden">
        Approval mode (alpha)
      </label>
      <span className="select">
        <select
          id={`${id}-select`}
          className="approval-mode-select"
          value={picker.selected}
          disabled={disabled}
          aria-describedby={`${id}-help${errorId ? ` ${errorId}` : ""}`}
          title={current?.description}
          onChange={(e) => onChange(e.target.value as ApprovalMode)}
        >
          {picker.options.map((o) => (
            <option key={o.value} value={o.value} title={o.description}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="upDown" size={13} />
      </span>
      <span className="approval-mode-tag" aria-hidden="true">
        Alpha
      </span>
      <span id={`${id}-help`} className="visually-hidden">
        {current?.description}
      </span>
    </span>
  );
}
