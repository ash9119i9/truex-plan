"use client";
import { useEffect, useId, useState } from "react";
import { budgetHelp, budgetOptions, parseTokenBudget } from "@/lib/goal";
import { Icon } from "./v2/icon";
import { RqIcon } from "./v2/rq-icon";

export type BudgetValue = { tokens: number | null; valid: boolean };

// Preset token budgets plus a custom amount, shared by the composer and the
// goal bar. Reports the parsed budget and whether the custom text is usable.
export function BudgetField({
  initial,
  onChange,
  selectClassName,
  showError = true,
  autoFocus = false,
  variant = "select",
}: {
  initial: number | null;
  onChange: (value: BudgetValue) => void;
  selectClassName?: string;
  showError?: boolean;
  autoFocus?: boolean;
  /** "chip": the r2 composer budget chip (clock icon, label, chevron). */
  variant?: "select" | "chip";
}) {
  const preset = budgetOptions.find((option) => option.value === initial);
  const [choice, setChoice] = useState(
    preset ? String(preset.value ?? "") : "custom",
  );
  const [custom, setCustom] = useState(preset ? "" : String(initial));
  const [touched, setTouched] = useState(false);
  const errorId = useId();
  const selectId = useId();
  const invalid = choice === "custom" && parseTokenBudget(custom) === null;
  const described = showError && touched && invalid;

  function report(nextChoice: string, nextCustom: string) {
    if (nextChoice === "custom") {
      const tokens = parseTokenBudget(nextCustom);
      onChange({ tokens, valid: tokens !== null });
    } else
      onChange({ tokens: nextChoice ? Number(nextChoice) : null, valid: true });
  }
  // Tell the parent the starting value, so a stale invalid state never lingers.
  useEffect(() => {
    report(choice, custom);
  }, []);

  return (
    <span className="budget-field">
      <span className={variant === "chip" ? "rq-chip budget-chip" : "select"}>
        <label className="sr-only" htmlFor={selectId}>
          Budget
        </label>
        {variant === "chip" && <RqIcon name="clock" size="sm" />}
        <select
          id={selectId}
          className={selectClassName}
          value={choice}
          autoFocus={autoFocus}
          onChange={(e) => {
            setChoice(e.target.value);
            setTouched(false);
            report(e.target.value, custom);
          }}
        >
          {budgetOptions.map((option) => (
            <option key={option.label} value={option.value ?? ""}>
              {option.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {variant === "chip" ? (
          <RqIcon name="chevd" size="sm" />
        ) : (
          <Icon name="upDown" size={13} />
        )}
      </span>
      {choice === "custom" && (
        <input
          type="text"
          inputMode="numeric"
          className="input budget-custom"
          aria-label="Custom token budget"
          aria-invalid={touched && invalid}
          aria-describedby={described ? errorId : undefined}
          placeholder="e.g. 50k"
          value={custom}
          maxLength={12}
          onChange={(e) => {
            setCustom(e.target.value);
            report("custom", e.target.value);
          }}
          onBlur={() => setTouched(true)}
          autoFocus
        />
      )}
      {described && (
        <span id={errorId} role="alert" className="budget-error">
          {budgetHelp}
        </span>
      )}
    </span>
  );
}
