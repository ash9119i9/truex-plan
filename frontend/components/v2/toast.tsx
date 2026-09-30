"use client";
import { ChIcon } from "./chrome-icons";
import type { ToastVM } from "@/lib/vm-chrome";

// Error toast (convo-v2-wireframe-r2 §3 Board A pin 4): rises above the composer
// once per error. Plain message, what happened to the turn, the ref in mono, and
// one fix action.
export function ErrorToast({
  toast,
  action,
  onDismiss,
}: {
  toast: ToastVM | null;
  /** The one fix action, e.g. { label: "Sign in again", onClick }. */
  action?: { label: string; onClick: () => void } | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  return (
    <div className="ch-toast" role="alert">
      <span className="ch-toast-ic">
        <ChIcon name="alert" />
      </span>
      <div className="ch-toast-tx">
        <b>{toast.title}</b>
        {toast.detail && <span>{toast.detail}</span>}
        {toast.ref && (
          <span className="ch-ref">
            <ChIcon name="key" sm />
            ref {toast.ref}
          </span>
        )}
      </div>
      <div className="ch-toast-act">
        {action && (
          <button className="btn soft" type="button" onClick={action.onClick}>
            {action.label}
          </button>
        )}
        <button type="button" className="ch-ib" aria-label="Dismiss" onClick={onDismiss}>
          <ChIcon name="x" sm />
        </button>
      </div>
    </div>
  );
}
