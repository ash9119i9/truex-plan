"use client";
import {
  cachedFraction,
  contextFraction,
  formatDuration,
  formatPercent,
  formatTokens,
  limitMeters,
  splitTokens,
  summarize,
  totalTokens,
  turnTokens,
} from "@/lib/observability";
import { useClock } from "../use-clock";
import type {
  RateLimitView,
  TraceSummary,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../../shared/contracts";
import { ColumnChart, Meter } from "./charts";

// Session-level answers: how fast, how much, how safe, and how close to limits.
export function InsightsPanel({
  traces,
  summary,
  rateLimits,
  liveUsage,
  timings,
}: {
  traces: TurnTrace[];
  summary?: TraceSummary | null;
  rateLimits: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  timings: TurnTiming[];
}) {
  // Live traces are newer than any fetched summary, so derive when they differ.
  const s = summary && summary.turns === traces.length ? summary : summarize(traces);
  const now = useClock(!!rateLimits);
  const meters = limitMeters(rateLimits, now);
  const latest = traces.at(-1);
  const contextUsage = liveUsage ?? latest?.usage ?? null;
  const context = contextFraction(contextUsage);
  const times = traces.map((t) => t.totalMs ?? 0);
  const slowest = times.length > 1 ? Math.max(...times) : -1;
  const cached = cachedFraction(s);
  return (
    <div className="obs-insights">
      <h3>Insights</h3>
      <dl className="obs-kpis">
        <div>
          <dt>Average time</dt>
          <dd>{formatDuration(s.avgTotalMs)}</dd>
        </div>
        <div>
          <dt>Slowest 5%</dt>
          <dd>{formatDuration(s.p95TotalMs)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatTokens(totalTokens(s))}</dd>
        </div>
        <div>
          <dt>Cached</dt>
          <dd>{formatPercent(cached)}</dd>
        </div>
        <div className={s.privacyFindings ? "warn" : ""}>
          <dt>Personal data</dt>
          <dd>
            {s.privacyFindings ? `${s.privacyFindings} detected` : "None detected"}
          </dd>
        </div>
      </dl>
      {!traces.length && (
        <p className="muted">
          Timing and usage for each response will appear here.
        </p>
      )}
      {traces.length > 0 && (
        <>
          <figure className="obs-figure">
            <figcaption>
              Time per response <span>{traces.length} responses</span>
            </figcaption>
            <ColumnChart
              title="Time per response"
              summary={`Average ${formatDuration(s.avgTotalMs)}, slowest ${formatDuration(Math.max(0, ...times))}`}
              format={formatDuration}
              columns={traces.map((t, i) => ({
                id: t.turnId,
                label: `Response ${i + 1}`,
                highlight: (t.totalMs ?? 0) === slowest && slowest > 0,
                segments: [
                  {
                    value: t.totalMs ?? 0,
                    tone: "seg-time",
                    label: "Time",
                  },
                ],
              }))}
            />
          </figure>
          <figure className="obs-figure">
            <figcaption>
              Tokens per response
              <span>{formatTokens(Math.max(0, ...traces.map(turnTokens)))} max</span>
            </figcaption>
            <ColumnChart
              title="Tokens per response"
              summary={`${formatTokens(totalTokens(s))} tokens in total, ${formatPercent(cached)} of input cached`}
              format={formatTokens}
              columns={traces.map((t, i) => {
                const split = splitTokens(t.usage);
                return {
                  id: t.turnId,
                  label: `Response ${i + 1}`,
                  segments: [
                    { value: split.newInput, tone: "seg-new", label: "New input" },
                    { value: split.cached, tone: "seg-cached", label: "Cached" },
                    {
                      value: split.output + split.reasoning + (t.helperUsage?.totalTokens ?? 0),
                      tone: "seg-output",
                      label: "Output",
                    },
                  ],
                };
              })}
            />
            <ul className="obs-legend" aria-hidden="true">
              <li>
                <i className="obs-swatch seg-new" />
                <span>New input</span>
              </li>
              <li>
                <i className="obs-swatch seg-cached" />
                <span>Cached</span>
              </li>
              <li>
                <i className="obs-swatch seg-output" />
                <span>Output</span>
              </li>
            </ul>
          </figure>
        </>
      )}
      {(context !== null || meters.length > 0) && (
        <div className="obs-meters">
          {context !== null && contextUsage && (
            <Meter
              value={context}
              label="Context window"
              caption={`${formatPercent(context)} used`}
              detail={`${formatTokens(contextUsage.contextUsedTokens ?? 0)} of ${formatTokens(contextUsage.contextWindow ?? 0)} tokens`}
            />
          )}
          {meters.map((m) => (
            <Meter
              key={m.label}
              value={m.usedPercent / 100}
              label={m.label}
              caption={`${Math.round(m.usedPercent)}% used`}
              detail={m.resets}
            />
          ))}
          {rateLimits?.reached && (
            <p className="obs-note warn" role="status">
              Usage limit reached. New requests may wait until it resets.
            </p>
          )}
        </div>
      )}
      {timings.length > 0 && (
        <details className="obs-streaming">
          <summary>Streaming details</summary>
          {timings.map((t, i) => (
            <div className="timing" key={t.turnId}>
              <b>Turn {i + 1}</b>
              <span>
                {" "}
                · {t.status}
                {t.nonStreaming ? " · non-streaming" : ""}
              </span>
              <div className="timing-bar">
                <i style={{ width: `${((t.ttftMs || 0) / (t.totalMs || 1)) * 100}%` }} />
                <i style={{ width: `${(t.streamMs / (t.totalMs || 1)) * 100}%` }} />
                <i style={{ width: `${(t.finalizeMs / (t.totalMs || 1)) * 100}%` }} />
              </div>
              <small>
                First output {formatDuration(t.ttftMs)} · stream{" "}
                {formatDuration(t.streamMs)} · total {formatDuration(t.totalMs)}
              </small>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
