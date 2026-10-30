"use client";
import { dismissToast, useToasts, type Toast } from "@/lib/toast";
import { Icon } from "./icon";
import { Tile } from "./tile";

// .tx-toast (DESIGN-SPEC 9.15): polite, never takes focus, dismissible.
const GLYPH = { ok: "✓", warn: "!", bad: "×" } as const;

export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="tx-toast-host" aria-live="polite">
      {toasts.map((toast) => {
        const tone = toast.tone ?? "ok";
        return (
          <div className="tx-toast" key={toast.id}>
            <Tile tone={tone}>{GLYPH[tone]}</Tile>
            <div>
              <h5>{toast.title}</h5>
              {toast.body && <p>{toast.body}</p>}
            </div>
            <button
              type="button"
              className="tx-toast-x"
              aria-label={`Dismiss: ${toast.title}`}
              onClick={() => onDismiss(toast.id)}
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function SharedToastHost() {
  return <ToastHost toasts={useToasts()} onDismiss={dismissToast} />;
}
