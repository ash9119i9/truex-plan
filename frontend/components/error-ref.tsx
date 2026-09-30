"use client";
import { useEffect, useState } from "react";
import type { ErrorRef as Ref } from "@/lib/api";
import { refText, type StreamError } from "@/lib/vm-stream";
import { StreamIcon } from "./stream-icon";

// Mono ref chip (wireframe §1 board 3, pin 6). Clicking copies the full ref
// so it can be pasted into a support request.
export function ErrorRef({ value }: { value: Ref | null | undefined }) {
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const text = refText(value);
  if (!text) return null;
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
    <>
      <button
        type="button"
        className="st-ref"
        onClick={() => void copy()}
        aria-label={`Copy error reference ${text}`}
        title={
          copied === "done"
            ? "Copied"
            : copied === "failed"
              ? "Select to copy"
              : "Copy reference"
        }
      >
        <StreamIcon name={copied === "done" ? "check" : "key"} sm />
        {text}
      </button>
      <span className="sr-only" role="status">
        {copied === "done" ? "Reference copied" : ""}
      </span>
    </>
  );
}

// Bad-tone card in the turn that failed: the message, one line on what to do
// next, the ref chip and Retry, which reruns the turn.
export function StreamErrorCard({
  error,
  onRetry,
}: {
  error: StreamError;
  onRetry?: () => void;
}) {
  return (
    <div className="st-err" role="alert">
      <span className="tile" aria-hidden="true">
        <StreamIcon name="alert" />
      </span>
      <div className="b">
        <b>{error.message}</b>
        {error.hint && <span>{error.hint}</span>}
      </div>
      {(error.ref || onRetry) && (
        <div className="acts">
          <ErrorRef value={error.ref} />
          {onRetry && (
            <button type="button" className="btn primary" onClick={onRetry}>
              <StreamIcon name="retry" sm />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
