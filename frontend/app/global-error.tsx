"use client";
import { useEffect } from "react";
import "./globals.css";

// Last-resort boundary for errors in the root layout. It replaces the layout,
// so it renders its own <html> and <body>. The app's CSS may be what failed,
// so inline styles keep it centred and readable without any stylesheet.
const FRAME = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: "1.5rem",
  fontFamily: "system-ui, sans-serif",
} as const;
const CARD = { maxWidth: "28rem", lineHeight: 1.5 } as const;
export default function GlobalError({
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
    console.error("[truex] app error", { digest: error.digest, error });
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main className="app-error" style={FRAME}>
          <div
            className="tx-card tx-state app-error-card"
            role="alert"
            style={CARD}
          >
            <h1 className="t-h3">Truex couldn’t load</h1>
            <p>
              Something went wrong while starting the workspace. Try again, or
              refresh the page.
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
      </body>
    </html>
  );
}
