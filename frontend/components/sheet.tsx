"use client";
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

// Right-hand slide-over built on the native modal dialog, so focus trapping,
// Escape to close and focus restoration come from the browser.
export function Sheet({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onClose={onClose}
      // The dialog has no padding, so a click on the element itself is a backdrop click.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <X size={16} />
          </button>
        </header>
        <div className="sheet-body">{open && children}</div>
      </div>
    </dialog>
  );
}
