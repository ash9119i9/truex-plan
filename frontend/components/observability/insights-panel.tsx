"use client";
import { useState, type CSSProperties } from "react";
import {
  cachedFraction,
  contextFraction,
  formatCost,
  formatDuration,
  formatPercent,
  formatTokens,
  limitMeters,
  sessionCostTotals,
  splitTokens,
  summarize,
  totalTokens,
  turnTokens,
} from "@/lib/observability";
import { elapsedMs, helperName, isRunning, spawnOrder } from "@/lib/subagents";
import { useClock } from "../use-clock";
import { Icon } from "../v2/icon";
import type {
  RateLimitView,
  SubAgent,
  TraceSummary,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../../shared/contracts";
import { ColumnChart, Meter } from "./charts";

// Spec share label: 0 → "0%", under 1 → "<1%", else rounded.
function inPct(part: number, total: number) {
  if (!total || part <= 0) return "0%";
  const p = (part / total) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}
// ≥10k rounds to whole "k"; smaller values keep formatTokens' precision.
function inShortK(n: number) {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : formatTokens(n);
}

interface Share {
  key: string;
  label: string;
  value: number;
  tone: string;
}

// Session-level answers: how fast, how much, how safe, and how close to limits.
export function InsightsPanel({
  traces,
  summary,
  rateLimits,
  liveUsage,
  timings,
  agents = [],
  skewMs,
}: {
  traces: TurnTrace[];
  summary?: TraceSummary | null;
  rateLimits: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  timings: TurnTiming[];
  agents?: SubAgent[];
  skewMs?: number;
}) {
  // Live traces are newer than any fetched summary, so derive when they differ.
  const s =
    summary && summary.turns === traces.length ? summary : summarize(traces);
  const now = useClock(!!rateLimits || agents.some(isRunning));
  const meters = limitMeters(rateLimits, now);
  const latest = traces.at(-1);
  const contextUsage = liveUsage ?? latest?.usage ?? null;
  const context = contextFraction(contextUsage);
  const times = traces.map((t) => t.totalMs ?? 0);
  const slowestMs = times.length ? Math.max(...times) : null;
  const slowest = times.length > 1 ? Math.max(...times) : -1;
  const cached = cachedFraction(s);
  const mainTokens = s.inputTokens + s.outputTokens;
  const helperTokens = s.helperTokens;
  const total = totalTokens(s);
  const money = sessionCostTotals(traces);
  const priced = money.requests - money.unpricedRequests;
  const helpers = spawnOrder(agents).map((a, i) => ({
    agent: a,
    name: helperName(a, agents),
    tone: i % 3,
    elapsed: elapsedMs(a, now, skewMs),
  }));
  const finished = helpers.filter((h) => h.agent.status === "completed").length;

  if (!traces.length && !meters.length && context === null)
    return (
      <div className="empty-tab">
        <span className="tile lg">
          <Icon name="chart" size={20} />
        </span>
        <span className="strong">No insights yet</span>
        <span className="muted sm">
          Timing and usage for each response will appear here.
        </span>
      </div>
    );

  // Per-helper token counts are not reported, so helpers share one segment.
  const shares: Share[] = [
    { key: "main", label: "Main agent", value: mainTokens, tone: "tone-main" },
    ...(helperTokens > 0
      ? [{ key: "helpers", label: "Helpers", value: helperTokens, tone: "tone-0" }]
      : []),
  ];
  const mainMs = times.reduce((a, b) => a + b, 0);
  const timeRows = [
    { key: "main", label: "Main agent", value: mainMs, tone: "tone-main" },
    ...helpers.map((h) => ({
      key: h.agent.threadId,
      label: h.name,
      value: h.elapsed,
      tone: `tone-${h.tone}`,
    })),
  ];
  const maxTime = Math.max(1, ...timeRows.map((r) => r.value));
  const ctxPct = context === null ? 0 : context * 100;

  return (
    <div className="in">
      <dl className="in-kpis">
        <div className="in-kpi">
          <dt>Average time</dt>
          <dd>{formatDuration(s.avgTotalMs)}</dd>
          <span className="in-sub">
            {s.turns} response{s.turns === 1 ? "" : "s"}
          </span>
        </div>
        <div className="in-kpi">
          <dt>Slowest</dt>
          <dd>{formatDuration(slowestMs)}</dd>
          {s.turns > 1 && (
            <span className="in-sub">Slowest 5% {formatDuration(s.p95TotalMs)}</span>
          )}
        </div>
        <div className="in-kpi">
          <dt>Tokens</dt>
          <dd>{formatTokens(total)}</dd>
          <span className="in-sub">
            {helperTokens > 0
              ? `${formatTokens(helperTokens)} from helpers`
              : `${formatPercent(cached)} cached`}
          </span>
        </div>
        {money.requests > 0 && (
          <div className={`in-kpi${money.unpricedRequests ? " is-warn" : ""}`}>
            <dt>Estimated cost</dt>
            <dd>{priced > 0 ? `≈ ${formatCost(money.costMicros)}` : "—"}</dd>
            <span className="in-sub">
              {money.unpricedRequests
                ? priced > 0
                  ? `${money.unpricedRequests} request${money.unpricedRequests === 1 ? "" : "s"} unpriced`
                  : "No price set for this model"
                : `${money.requests} model request${money.requests === 1 ? "" : "s"}`}
            </span>
          </div>
        )}
        {helpers.length > 0 && (
          <div className="in-kpi">
            <dt>Helpers</dt>
            <dd>{helpers.length}</dd>
            {finished > 0 && <span className="in-sub">{finished} finished</span>}
          </div>
        )}
        <div className={`in-kpi${s.privacyFindings ? " is-warn" : ""}`}>
          <dt>Personal data</dt>
          <dd>{s.privacyFindings ? s.privacyFindings : "None"}</dd>
          <span className="in-sub">
            Pattern checks on sent text
          </span>
        </div>
      </dl>

      {total > 0 && (
        <section className="in-card" aria-labelledby="in-tokens-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-tokens-title">
              Tokens by agent
            </h3>
            <span className="muted sm">{formatTokens(total)} total</span>
          </div>
          <ShareBar shares={shares} total={total} />
          <table className="in-legend">
            <caption className="sr-only">Tokens by agent</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Colour</th>
                <th scope="col">Agent</th>
                <th scope="col">Tokens</th>
                <th scope="col">Share</th>
              </tr>
            </thead>
            <tbody>
              {shares.map((x) => (
                <tr key={x.key} className={x.tone}>
                  <td>
                    <i className="in-swatch" aria-hidden="true" />
                  </td>
                  <td className="in-name">{x.label}</td>
                  <td className="num">{formatTokens(x.value)}</td>
                  <td className="num muted">{inPct(x.value, total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {traces.length > 0 && (
        <section className="in-card" aria-labelledby="in-time-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-time-title">
              Time by agent
            </h3>
          </div>
          <div className="in-rows">
            {timeRows.map((r) => (
              <div key={r.key} className={`in-row ${r.tone}`}>
                <span className="in-row-name" title={r.label}>
                  {r.label}
                </span>
                <div className="in-row-track" aria-hidden="true">
                  <div
                    className="in-row-bar"
                    style={{ width: `${Math.max(1, (r.value / maxTime) * 100)}%` }}
                  />
                </div>
                <span className="in-row-val mono">{formatDuration(r.value)}</span>
              </div>
            ))}
          </div>
          {helpers.length > 0 && (
            <p className="muted sm">
              Helpers run in parallel, so their times overlap.
            </p>
          )}
        </section>
      )}

      {context !== null && contextUsage && (
        <section className="in-card" aria-labelledby="in-ctx-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-ctx-title">
              Main agent context
            </h3>
            <span className="muted sm">
              {inShortK(contextUsage.contextUsedTokens ?? 0)} of{" "}
              {inShortK(contextUsage.contextWindow ?? 0)} ·{" "}
              {formatPercent(context)}
            </span>
          </div>
          <div
            className={`in-meter${ctxPct >= 90 ? " is-crit" : ctxPct >= 75 ? " is-warn" : ""}`}
            role="meter"
            aria-label="Main agent context"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ctxPct)}
          >
            <span style={{ width: `${Math.min(100, ctxPct)}%` }} />
          </div>
          <p className="in-note">
            Only the main agent&apos;s context is shown.
            {helperTokens > 0 &&
              " Helpers use their own context windows, so their tokens don't fill this one."}
          </p>
        </section>
      )}

      {traces.length > 0 && (
        <section className="in-card" aria-labelledby="in-per-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-per-title">
              Time per response
            </h3>
            <span className="muted sm">
              {traces.length} response{traces.length === 1 ? "" : "s"}
            </span>
          </div>
          <ColumnChart
            title="Time per response"
            summary={`Average ${formatDuration(s.avgTotalMs)}, slowest ${formatDuration(Math.max(0, ...times))}`}
            format={formatDuration}
            columns={traces.map((t, i) => ({
              id: t.turnId,
              label: `Response ${i + 1}`,
              highlight: (t.totalMs ?? 0) === slowest && slowest > 0,
              segments: [
                { value: t.totalMs ?? 0, tone: "seg-time", label: "Time" },
              ],
            }))}
          />
        </section>
      )}

      {traces.length > 0 && (
        <section className="in-card" aria-labelledby="in-tpr-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-tpr-title">
              Tokens per response
            </h3>
            <span className="muted sm">
              {formatTokens(Math.max(0, ...traces.map(turnTokens)))} max
            </span>
          </div>
          <ColumnChart
            title="Tokens per response"
            summary={`${formatTokens(total)} tokens in total, ${formatPercent(cached)} of input cached`}
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
                    value:
                      split.output +
                      split.reasoning +
                      (t.helperUsage?.totalTokens ?? 0),
                    tone: "seg-output",
                    label: "Output",
                  },
                ],
              };
            })}
          />
          <ul className="in-keys" aria-hidden="true">
            <li>
              <i className="in-key seg-new" />
              <span>New input</span>
            </li>
            <li>
              <i className="in-key seg-cached" />
              <span>Cached</span>
            </li>
            <li>
              <i className="in-key seg-output" />
              <span>Output</span>
            </li>
          </ul>
        </section>
      )}

      {priced > 0 && (
        <section className="in-card" aria-labelledby="in-cost-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-cost-title">
              Estimated cost per response
            </h3>
            <span className="muted sm">≈ {formatCost(money.costMicros)} total</span>
          </div>
          <ColumnChart
            title="Estimated cost per response"
            summary={`Estimated ${formatCost(money.costMicros)} in total across ${traces.length} responses`}
            format={formatCost}
            columns={traces.map((t, i) => ({
              id: t.turnId,
              label: `Response ${i + 1}`,
              segments: [
                {
                  value: t.cost?.costMicros ?? 0,
                  tone: "seg-output",
                  label: "Cost",
                },
              ],
            }))}
          />
          <p className="in-note">
            Estimated from token counts and list prices. The provider&apos;s
            bill is the real figure.
          </p>
        </section>
      )}

      {meters.length > 0 && (
        <section className="in-card" aria-labelledby="in-limits-title">
          <div className="in-card-head">
            <h3 className="in-card-title" id="in-limits-title">
              Usage limits
            </h3>
          </div>
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
            <p className="in-note is-warn" role="status">
              Usage limit reached. New requests may wait until it resets.
            </p>
          )}
        </section>
      )}

      {timings.length > 0 && (
        <details className="in-card in-details">
          <summary>Streaming details</summary>
          {timings.map((t, i) => (
            <div className="in-timing" key={t.turnId}>
              <span>
                <b>Turn {i + 1}</b> · {t.status}
                {t.nonStreaming ? " · non-streaming" : ""}
              </span>
              <div className="in-timing-bar" aria-hidden="true">
                <i style={{ width: `${((t.ttftMs || 0) / (t.totalMs || 1)) * 100}%` }} />
                <i style={{ width: `${(t.streamMs / (t.totalMs || 1)) * 100}%` }} />
                <i style={{ width: `${(t.finalizeMs / (t.totalMs || 1)) * 100}%` }} />
              </div>
              <span className="muted sm">
                First output {formatDuration(t.ttftMs)} · stream{" "}
                {formatDuration(t.streamMs)} · total {formatDuration(t.totalMs)}
              </span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// Part-to-whole bar with a hover/focus tooltip placed so it never overflows.
function ShareBar({ shares, total }: { shares: Share[]; total: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const visible = shares.filter((x) => x.value > 0);
  let start = 0;
  const spans = visible.map((x) => {
    const s = (start / total) * 100;
    start += x.value;
    return { ...x, start: s, end: (start / total) * 100 };
  });
  const tip = hover === null ? null : spans[hover];
  const mid = tip ? (tip.start + tip.end) / 2 : 0;
  const tipStyle: CSSProperties | undefined = !tip
    ? undefined
    : mid < 25
      ? { left: `${tip.start}%` }
      : mid > 75
        ? { right: `${100 - tip.end}%` }
        : { left: `${mid}%`, transform: "translateX(-50%)" };
  const alt = `Tokens by agent: ${visible
    .map((x) => `${x.label} ${formatTokens(x.value)}, ${inPct(x.value, total)}`)
    .join("; ")}`;
  return (
    <div className="in-stack-wrap">
      <div
        className={`in-stack${hover !== null ? " is-hovering" : ""}`}
        role="img"
        aria-label={alt}
        tabIndex={0}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(0)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const step = e.key === "ArrowRight" ? 1 : -1;
            setHover((h) => ((h ?? 0) + step + spans.length) % spans.length);
          }
        }}
      >
        {spans.map((x, i) => (
          <i
            key={x.key}
            className={`in-seg ${x.tone}${hover === i ? " is-hover" : ""}`}
            style={{ flexGrow: x.value }}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </div>
      {tip && (
        <div className="in-tip" style={tipStyle} aria-hidden="true">
          <b>{tip.label}</b>
          {formatTokens(tip.value)} · {inPct(tip.value, total)}
        </div>
      )}
    </div>
  );
}
