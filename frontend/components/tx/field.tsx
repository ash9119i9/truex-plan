"use client";
import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { classes } from "./classes";

// .tx-field (DESIGN-SPEC 9.11): label above, always; then the control; then a
// hint or an error that names the fix, tied to the control with aria-describedby.
export type FieldControl = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
};

export type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: (control: FieldControl) => ReactNode;
};

export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={classes("tx-field", className)}>
      <label htmlFor={id}>
        {label}
        {required && (
          <>
            {" "}
            <span className="tx-req" aria-hidden="true">
              *
            </span>
          </>
        )}
      </label>
      {children({
        id,
        "aria-describedby": note ? noteId : undefined,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error ? (
        <span className="tx-hint tx-errmsg" id={noteId}>
          <span aria-hidden="true">!</span>
          {error}
        </span>
      ) : (
        hint && (
          <span className="tx-hint" id={noteId}>
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={classes("tx-input", className)} {...rest} />;
}

export function TextArea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={classes("tx-input", className)} {...rest} />;
}

export function Select({
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={classes("tx-input tx-select", className)} {...rest} />
  );
}

// .tx-secret + .tx-reveal: masked by default; the toggle's state and label flip.
export function Secret({
  id,
  noun,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  id: string;
  /** What the value is, for the toggle's label ("Show token"). */
  noun: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="tx-secret">
      <input
        className={classes("tx-input", className)}
        id={id}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      <button
        className="tx-reveal"
        type="button"
        aria-pressed={shown}
        aria-controls={id}
        aria-label={`${shown ? "Hide" : "Show"} ${noun}`}
        onClick={() => setShown((value) => !value)}
      >
        <span className="t-micro">{shown ? "Hide" : "Show"}</span>
      </button>
    </div>
  );
}

// .tx-switch (DESIGN-SPEC 9.12): instant on/off, never a save. Space toggles it
// natively because it is a checkbox.
export type SwitchProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function Switch({ label, checked, onChange, disabled }: SwitchProps) {
  return (
    <label className="tx-row">
      <input
        type="checkbox"
        role="switch"
        className="tx-switch"
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
