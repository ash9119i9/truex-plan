"use client";
import { useEffect, useState } from "react";
import type { ErrorRef as Ref } from "@/lib/api";

// Small muted "Ref: CODE · requestId" line under an error message, with a
// copy button so the reference can be pasted into a support request.
export function ErrorRef({ value }: { value: Ref | null | undefined }) {
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!value || (!value.code && !value.requestId && !value.turnId)) return null;
  const text = [value.code, value.requestId ?? value.turnId]
    .filter(Boolean)
    .join(" · ");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      // Clipboard access can be blocked; the text stays selectable.
      setCopied("failed");
    }
  }
  return (
    <span className="error-ref">
      <span className="error-ref-text">Ref: {text}</span>
      <button
        type="button"
        className="error-ref-copy"
        onClick={() => void copy()}
        aria-label={`Copy error reference ${text}`}
      >
        {copied === "done"
          ? "Copied"
          : copied === "failed"
            ? "Select to copy"
            : "Copy"}
      </button>
      <span className="sr-only" role="status">
        {copied === "done" ? "Reference copied" : ""}
      </span>
    </span>
  );
}
