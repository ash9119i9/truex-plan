"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatRun } from "@/lib/tenant-chat";
import { compactCount, modelLabel, traceTimings } from "@/lib/turn";
import { Button } from "@/components/tx/button";
import { Icon } from "@/components/tx/icon";

// The receipt at the end of a settled turn and the trace card it opens
// (DESIGN-SPEC 12.8), limited to what the platform records for a run: its
// timestamps and token usage. Steps waterfall, context jar, privacy and model
// context need data the platform doesn't send yet (backlog 02, 04, 08).

const STATUS: Partial<
  Record<
    ChatRun["status"],
    { word: string; tone: string; glyph: "check" | "alert" | "stop" }
  >
> = {
  completed: { word: "Completed", tone: "tx-pill-ok", glyph: "check" },
  failed: { word: "Failed", tone: "tx-pill-bad", glyph: "alert" },
  stopped: { word: "Stopped", tone: "tx-pill-line", glyph: "stop" },
};

const tokensOf = (run: ChatRun) =>
  run.usage ? run.usage.input + run.usage.output : 0;

export function Receipt({
  run,
  model,
  steps,
  helpers = 0,
}: {
  run: ChatRun;
  model?: string | null;
  steps: number;
  helpers?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const total = traceTimings(run).find(([label]) => label === "Total")?.[1];
  const tokens = tokensOf(run);
  const name = modelLabel(model);
  return (
    <>
      <div className="cs-receipt num">
        {total && (
          <span>
            <Icon name="clock" size="sm" />
            {total}
          </span>
        )}
        {tokens > 0 && (
          <span>
            <Icon name="sigma" size="sm" />
            {compactCount(tokens)} tokens
          </span>
        )}
        {name && (
          <span>
            <Icon name="spark" size="sm" />
            {name}
          </span>
        )}
        <button
          ref={toggle}
          type="button"
          className="tx-chip cs-receipt-details"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((now) => !now)}
        >
          Details
        </button>
      </div>
      {open && (
        <TraceCard
          id={id}
          run={run}
          steps={steps}
          helpers={helpers}
          onClose={() => {
            setOpen(false);
            toggle.current?.focus();
          }}
        />
      )}
    </>
  );
}

export function TraceCard({
  id,
  run,
  steps,
  helpers,
  onClose,
}: {
  id?: string;
  run: ChatRun;
  steps: number;
  helpers: number;
  onClose: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const status = STATUS[run.status];
  const timings = traceTimings(run);
  const usage = run.usage;
  const total = timings.find(([label]) => label === "Total")?.[1];
  return (
    <section
      ref={box}
      id={id}
      className="cs-trace"
      role="region"
      aria-label="Turn trace"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="cs-trace-head">
        <span className="tx-tile tx-tile-signal" aria-hidden="true">
          <Icon name="activity" size="sm" />
        </span>
        <span className="cs-trace-title">
          <b>Turn trace</b>
          <small className="num">
            {[
              total,
              `${steps} ${steps === 1 ? "step" : "steps"}`,
              helpers
                ? `${helpers} ${helpers === 1 ? "helper" : "helpers"}`
                : "no helpers",
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
        {status && (
          <span className={`tx-pill ${status.tone}`}>
            <Icon name={status.glyph} size="sm" />
            {status.word}
          </span>
        )}
        <Button
          iconOnly
          icon="x"
          variant="ghost"
          size="xs"
          aria-label="Close turn trace"
          onClick={onClose}
        />
      </header>
      {timings.length > 0 && (
        <div className="cs-trace-part">
          <h4 className="t-micro">Timing</h4>
          <dl className="cs-trace-dl">
            {timings.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="num">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {usage && (
        <div className="cs-trace-part">
          <h4 className="t-micro">Billed as</h4>
          <table className="cs-trace-table">
            <caption className="tx-sr">Tokens by role</caption>
            <tbody>
              {(
                [
                  ["Input", usage.input],
                  ["Cached (of input)", usage.cached],
                  ["Output", usage.output],
                  ["Reasoning (of output)", usage.reasoning],
                  ["Total", usage.input + usage.output],
                ] as const
              ).map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className="num">{value.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
