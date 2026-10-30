"use client";
import { useEffect } from "react";

// Route-level error boundary: a render error below the root layout lands here.
export default function ErrorPage({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  // Next 16.3+: retry re-fetches and re-renders; reset only re-renders.
  retry?: () => void;
  reset?: () => void;
}) {
  const tryAgain = retry ?? reset;
  useEffect(() => {
    console.error("[truex] page error", { digest: error.digest, error });
  }, [error]);
  return (
    <main className="app-error">
      <div className="tx-card tx-state app-error-card" role="alert">
        <h1 className="t-h3">Something went wrong</h1>
        <p>
          This page hit an unexpected problem. Your conversations are saved, so
          you can try again safely.
        </p>
        {error.digest && (
          <p className="app-error-ref">Reference: {error.digest}</p>
        )}
        <button
          type="button"
          className="tx-btn tx-primary"
          onClick={() => (tryAgain ? tryAgain() : location.reload())}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
