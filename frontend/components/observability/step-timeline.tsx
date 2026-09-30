"use client";
import { Fragment } from "react";
import { waterfallVM } from "@/lib/vm-insights";
import type { TurnTrace } from "../../../shared/contracts";
import { ObIcon } from "./ob-icon";

// Waterfall of every step, grouped by agent on the turn's own clock. Bars are
// decorative; each row's label and duration are the text alternative.
export function StepTimeline({
  trace,
  nowMs,
  agentName,
  privacyStepIds,
}: {
  trace: TurnTrace;
  // Offset from the turn's start, for running turns.
  nowMs?: number;
  agentName?: string;
  // Steps that carry a privacy finding (not in the contract yet).
  privacyStepIds?: Set<string>;
}) {
  const wf = waterfallVM(trace, { nowMs, agentName });
  if (!wf.groups.length)
    return <p className="ob-oneline">No steps were recorded for this turn.</p>;
  return (
    <>
      <div className="ob-wf-scroll">
        <div className="ob-wf" role="list" aria-label="Steps by agent">
          <div className="ob-grid" aria-hidden="true">
            {wf.grid.map((g) => (
              <i
                key={g.left}
                className={g.now ? "ob-now" : undefined}
                style={{ left: `${g.left}%` }}
              />
            ))}
          </div>
          <div className="ob-axis" aria-hidden="true">
            <span />
            <div className="ob-ticks">
              {wf.ticks.map((t) => (
                <span
                  key={t.left}
                  className={t.now ? "ob-nowlab" : undefined}
                  style={{ left: t.left ? `${t.left}%` : 0 }}
                >
                  {t.label}
                </span>
              ))}
            </div>
            <span />
          </div>
          {wf.groups.map((g) => (
            <Fragment key={g.id}>
              <div className={`ob-row ob-grp ${g.tone}`} role="listitem">
                <span className="ob-lab">
                  <span className="h-av" aria-hidden="true">
                    {g.initial}
                  </span>
                  <span>{g.label}</span>
                </span>
                <span className="ob-trk" aria-hidden="true">
                  <i
                    className="ob-span"
                    style={{ left: `${g.left}%`, width: `${g.width}%` }}
                  />
                </span>
                <span className="ob-dur">{g.duration}</span>
              </div>
              {g.rows.map((r) => (
                <div
                  key={r.id}
                  className={`ob-row${r.error ? " is-err" : ""}`}
                  role="listitem"
                >
                  <span className="ob-lab">
                    {r.error && <ObIcon name="alert" sm />}
                    <span title={r.label}>
                      {r.label}
                      {r.error && <span className="sr-only"> (failed)</span>}
                    </span>
                    {privacyStepIds?.has(r.id) && (
                      <ObIcon name="shield" sm className="ob-mark" />
                    )}
                  </span>
                  <span className="ob-trk" aria-hidden="true">
                    <i
                      className={`ob-bar ob-k-${r.kind}`}
                      style={{ left: `${r.left}%`, width: `${r.width}%` }}
                    />
                    {r.errAt !== null && (
                      <span className="ob-errx" style={{ left: `${r.errAt}%` }}>
                        <ObIcon name="x" />
                      </span>
                    )}
                  </span>
                  <span className="ob-dur">{r.duration}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="ob-legend" aria-hidden="true">
        <span>
          <i className="ob-k-think" />
          Thinking
        </span>
        <span>
          <i className="ob-k-file" />
          Reading files
        </span>
        <span>
          <i className="ob-k-tool" />
          Tool call
        </span>
        <span>
          <i className="ob-k-write" />
          Writing
        </span>
        <span>
          <i className="ob-k-wait" />
          Waiting
        </span>
        <span>
          <i className="ob-k-err" />
          Error
        </span>
        {privacyStepIds && privacyStepIds.size > 0 && (
          <span>
            <ObIcon name="shield" sm className="ob-mark" />
            Privacy finding
          </span>
        )}
      </div>
    </>
  );
}
