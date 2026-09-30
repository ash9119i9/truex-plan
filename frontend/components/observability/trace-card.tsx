"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { formatDuration } from "@/lib/observability";
import {
  contextVM,
  limitsVM,
  stepErrorsVM,
  timingVM,
  traceStatus,
  traceSubtitle,
} from "@/lib/vm-insights";
import type {
  RateLimitView,
  TurnTiming,
  TurnTrace,
} from "../../../shared/contracts";
import { ObIcon } from "./ob-icon";
import { StepTimeline } from "./step-timeline";
import { TokenBar } from "./token-bar";
import { PrivacyCard } from "./privacy-card";
import { ModelContext } from "./model-context";
import { useDeveloperMode } from "./use-developer-mode";

// Level 2: the turn trace. Waterfall, tokens, context, timing, privacy and
// account limits. In dev mode a Trace / Model context switch flips the card
// to what the model saw.
export function TraceCard({
  trace,
  sessionId,
  id,
  turnNumber,
  timing,
  rateLimits,
  agentName,
  onClose,
}: {
  trace: TurnTrace;
  sessionId?: string;
  id: string;
  turnNumber?: number;
  timing?: TurnTiming | null;
  rateLimits?: RateLimitView | null;
  agentName?: string;
  onClose?: () => void;
}) {
  const [developer] = useDeveloperMode();
  const [view, setView] = useState<"trace" | "context">("trace");
  // Leaving dev mode always returns to the public view.
  useEffect(() => {
    if (!developer) setView("trace");
  }, [developer]);
  const showContext = developer && view === "context";
  const status = traceStatus(trace);
  const subtitle = traceSubtitle(trace, turnNumber);
  const headTile = showContext ? "layers" : status.tone === "warn" || status.tone === "bad" ? "alert" : "activity";
  return (
    <section
      className="ob-trace"
      id={id}
      aria-label={showContext ? "Model context" : "Turn trace"}
    >
      <div className="ob-th">
        <span className={`ob-tile${!showContext && status.tone !== "ok" && status.tone !== "live" ? " warn" : ""}`}>
          <ObIcon name={headTile} />
        </span>
        <span className="ob-title">
          <b>{showContext ? "Model context" : "Turn trace"}</b>
          <small>
            {showContext
              ? [turnNumber ? `T${turnNumber}` : null, "Main agent", "what the model saw"]
                  .filter(Boolean)
                  .join(" · ")
              : subtitle}
          </small>
        </span>
        {showContext ? (
          <span className="ob-dev">
            <ObIcon name="term" sm />
            Dev
          </span>
        ) : (
          <span className={`ob-status${status.tone === "ok" ? "" : ` ${status.tone}`}`}>
            {status.tone === "live" ? (
              <span className="pulse" />
            ) : (
              <ObIcon name={status.tone === "ok" ? "check" : "alert"} sm />
            )}
            {status.label}
          </span>
        )}
        <span className="ob-right">
          {developer && (
            <span className="seg" role="group" aria-label="Trace view">
              <button
                type="button"
                className={view === "trace" ? "on" : undefined}
                aria-pressed={view === "trace"}
                onClick={() => setView("trace")}
              >
                Trace
              </button>
              <button
                type="button"
                className={view === "context" ? "on" : undefined}
                aria-pressed={view === "context"}
                onClick={() => setView("context")}
              >
                Model context
              </button>
            </span>
          )}
          {onClose && (
            <button
              type="button"
              className="ob-iconbtn"
              aria-label="Close turn trace"
              onClick={onClose}
            >
              <ObIcon name="x" />
            </button>
          )}
        </span>
      </div>
      {showContext ? (
        <ModelContext
          sessionId={sessionId}
          turnId={trace.turnId}
          contextWindow={trace.usage?.contextWindow}
        />
      ) : (
        <TraceBody
          trace={trace}
          timing={timing}
          rateLimits={rateLimits ?? trace.rateLimits}
          agentName={agentName}
        />
      )}
    </section>
  );
}

function TraceBody({
  trace,
  timing,
  rateLimits,
  agentName,
}: {
  trace: TurnTrace;
  timing?: TurnTiming | null;
  rateLimits: RateLimitView | null;
  agentName?: string;
}) {
  const errors = stepErrorsVM(trace);
  const ctx = contextVM(trace.usage);
  const spec = timingVM(timing);
  const limits = limitsVM(rateLimits);
  const [copied, setCopied] = useState<string | null>(null);
  async function copyRef(ref: string) {
    try {
      await navigator.clipboard.writeText(ref);
      setCopied(ref);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard can be blocked; the id is visible to copy by hand.
    }
  }
  return (
    <>
      <div className="ob-sec">
        <div className="ob-h">
          <ObIcon name="list" sm />
          Steps
          {trace.totalMs !== null && (
            <span className="ob-r">{formatDuration(trace.totalMs)} wall time</span>
          )}
        </div>
        <StepTimeline trace={trace} agentName={agentName} />
        {errors.map((e) => (
          <div className="ob-err" key={e.id} role="note">
            <span className="ob-tile">
              <ObIcon name="x" />
            </span>
            <div>
              <b>{e.title}</b>
              <br />
              {e.detail} <code>{e.ref}</code>
            </div>
            <div className="row">
              <button type="button" className="btn ghost" onClick={() => void copyRef(e.ref)}>
                {copied === e.ref ? "Copied" : "Copy error id"}
              </button>
              <span className="sr-only" role="status">
                {copied === e.ref ? "Error id copied" : ""}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="ob-cols">
        <div className="ob-sec">
          <div className="ob-h">
            <ObIcon name="sigma" sm />
            Tokens
          </div>
          <TokenBar usage={trace.usage} helperUsage={trace.helperUsage} />
        </div>
        {(ctx || spec.length > 0) && (
          <div className="ob-sec">
            {ctx && (
              <>
                <div className="ob-h">
                  <ObIcon name="layers" sm />
                  Context window
                </div>
                <div className="ob-ctxrow">
                  <span
                    className={`ring ob-ring${ctx.tone === "ok" ? "" : ` ${ctx.tone}`}`}
                    style={{ "--p": Math.round(ctx.percent) } as CSSProperties}
                    role="meter"
                    aria-label="Main agent context window"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(ctx.percent)}
                  >
                    <span>{ctx.pctText}</span>
                  </span>
                  <p>
                    <b>{ctx.text}</b>Main agent, after this turn. Warns at 75%.
                  </p>
                </div>
              </>
            )}
            {spec.length > 0 && (
              <>
                <div className="ob-h" style={ctx ? { marginTop: 4 } : undefined}>
                  <ObIcon name="clock" sm />
                  Timing
                </div>
                <dl className="ob-spec">
                  {spec.map((s) => (
                    <div key={s.label}>
                      <dt>{s.label}</dt>
                      <dd>{s.value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        )}
      </div>

      <PrivacyCard report={trace.privacy} />

      {limits.length > 0 && <LimitsFoot limits={limits} />}
    </>
  );
}

export function LimitsFoot({ limits }: { limits: ReturnType<typeof limitsVM> }) {
  return (
    <div className="ob-foot">
      <b>
        <ObIcon name="key" sm />
        Account limits
      </b>
      {limits.map((m) => (
        <span
          key={m.key}
          className={`ob-meter${m.tone === "ok" ? "" : ` ${m.tone}`}`}
        >
          {m.label}
          <span
            className={`bar${m.tone === "ok" ? "" : ` ${m.tone}`}`}
            role="meter"
            aria-label={`${m.label} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(m.percent)}
          >
            <i style={{ width: `${m.percent}%` }} />
          </span>
          <b>{m.pctText}</b>
          {m.note}
        </span>
      ))}
    </div>
  );
}
