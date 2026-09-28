"use client";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatTokens, receipt, turnTokens } from "@/lib/observability";
import type { TurnTrace, TurnUsage } from "../../../shared/contracts";
import { TraceCard } from "./trace-card";

// Level 1: one quiet line under a finished answer. Click to open level 2.
export function TurnReceipt({
  trace,
  sessionId,
}: {
  trace: TurnTrace;
  sessionId?: string;
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const r = receipt(trace);
  const cardId = `trace-${trace.turnId.replace(/[^\w-]/g, "-")}`;
  const Shield = r.privacy.tone === "warn" ? ShieldAlert : ShieldCheck;
  return (
    <div className="obs-receipt-wrap">
      <button
        type="button"
        className={`obs-receipt${r.privacy.tone === "warn" ? " warn" : ""}`}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={`${r.label}. ${open ? "Hide" : "Show"} details`}
        onClick={() => setOpen((v) => !v)}
      >
        {r.duration && <span>{r.duration}</span>}
        {r.tokens && <span>{r.tokens}</span>}
        <span className="obs-receipt-privacy">
          <Shield size={12} aria-hidden="true" />
          {r.privacy.text}
        </span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={open ? "obs-chevron open" : "obs-chevron"}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="card"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <TraceCard trace={trace} sessionId={sessionId} id={cardId} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// While a turn runs, only a live token count is known.
export function LiveUsage({ usage }: { usage: TurnUsage }) {
  const total = turnTokens({ usage, helperUsage: null } as TurnTrace);
  if (!total) return null;
  return (
    <p className="obs-receipt live" aria-live="off">
      <span>{formatTokens(total)} tokens so far</span>
    </p>
  );
}
