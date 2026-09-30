"use client";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
// No shield in the v2 icon set, so lucide stays for the privacy mark.
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Icon } from "../v2/icon";
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
    <div className="msg-foot">
      <button
        type="button"
        className={`msg-foot-btn${r.privacy.tone === "warn" ? " warn" : ""}`}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={`${r.label}. ${open ? "Hide" : "Show"} details`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{[r.duration, r.tokens].filter(Boolean).join(" · ")}</span>
        <span className="msg-foot-privacy">
          <Shield size={12} aria-hidden="true" />
          {r.privacy.text}
        </span>
        <Icon
          name="chevron"
          size={12}
          className={open ? "msg-foot-chevron open" : "msg-foot-chevron"}
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
    <p className="msg-foot live" aria-live="off">
      <span>{formatTokens(total)} tokens so far</span>
    </p>
  );
}
