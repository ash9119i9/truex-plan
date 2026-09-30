"use client";
import { useEffect, useState } from "react";
import { liveReceiptVM, receiptVM } from "@/lib/vm-insights";
import type {
  RateLimitView,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../../shared/contracts";
import { ObIcon } from "./ob-icon";
import { TraceCard } from "./trace-card";

// Opening one trace closes any other open trace on the page.
const openListeners = new Set<(id: string) => void>();
function announceOpen(id: string) {
  for (const l of openListeners) l(id);
}

// Level 1: one quiet receipt line under a finished answer. Details opens the
// trace card right under it.
export function TurnReceipt({
  trace,
  sessionId,
  turnNumber,
  timing,
  rateLimits,
  agentName,
}: {
  trace: TurnTrace;
  sessionId?: string;
  // Optional: "T1" in the trace header. Omitted when unknown.
  turnNumber?: number;
  // Optional: the turn's latency breakdown for the Timing sheet.
  timing?: TurnTiming | null;
  // Optional: the account's latest limits; falls back to the trace's own.
  rateLimits?: RateLimitView | null;
  // Optional: main agent's name, for its initial in the waterfall.
  agentName?: string;
}) {
  const [open, setOpen] = useState(false);
  const cardId = `trace-${trace.turnId.replace(/[^\w-]/g, "-")}`;
  useEffect(() => {
    const close = (id: string) => {
      if (id !== cardId) setOpen(false);
    };
    openListeners.add(close);
    return () => {
      openListeners.delete(close);
    };
  }, [cardId]);
  const r = receiptVM(trace);
  function toggle() {
    if (!open) announceOpen(cardId);
    setOpen(!open);
  }
  return (
    <>
      <div className="ob-receipt">
        {r.running && (
          <span className="ob-flag live">
            <span className="pulse" />
            Running
          </span>
        )}
        {r.duration && (
          <span>
            <ObIcon name="clock" sm />
            {r.duration}
          </span>
        )}
        {r.tokens && (
          <span>
            <ObIcon name="sigma" sm />
            {r.tokens}
          </span>
        )}
        {r.model && (
          <span>
            <ObIcon name="spark" sm />
            {r.model}
          </span>
        )}
        {r.privacy > 0 && (
          <span className="ob-flag warn">
            <ObIcon name="shield" sm />
            {r.privacy} privacy
          </span>
        )}
        {r.errors > 0 && (
          <span className="ob-flag bad">
            <ObIcon name="alert" sm />
            {r.errors} error{r.errors === 1 ? "" : "s"}
          </span>
        )}
        <button
          type="button"
          className={`ob-details${open ? " on" : ""}`}
          aria-expanded={open}
          aria-controls={open ? cardId : undefined}
          aria-label={`${r.label}. ${open ? "Hide" : "Show"} details`}
          onClick={toggle}
        >
          Details
          <ObIcon name="chevd" sm />
        </button>
      </div>
      {open && (
        <TraceCard
          trace={trace}
          sessionId={sessionId}
          id={cardId}
          turnNumber={turnNumber}
          timing={timing}
          rateLimits={rateLimits}
          agentName={agentName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// While a turn runs, only a live token count is known.
export function LiveUsage({ usage }: { usage: TurnUsage }) {
  const { tokens } = liveReceiptVM(usage);
  if (!tokens) return null;
  return (
    <div className="ob-receipt" aria-live="off">
      <span className="ob-flag live">
        <span className="pulse" />
        Running
      </span>
      <span>
        <ObIcon name="sigma" sm />
        {tokens}
      </span>
    </div>
  );
}
