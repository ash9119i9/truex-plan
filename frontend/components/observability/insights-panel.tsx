"use client";
import type { CSSProperties } from "react";
import {
  budgetByTurnVM,
  contextVM,
  limitsVM,
  privacyVM,
  sessionVM,
  turnSliceVM,
} from "@/lib/vm-insights";
import type {
  RateLimitView,
  SubAgent,
  TraceSummary,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../../shared/contracts";
import { Icon } from "../v2/icon";
import { ObIcon } from "./ob-icon";

// Insights tab. Session scope: sums, averages, p95 turn time, tokens per turn,
// main vs helper split, context fill, account limits and privacy. This turn
// scope: the selected turn's trace numbers and its share of the session.
export function InsightsPanel({
  traces,
  rateLimits,
  liveUsage,
  scope = "session",
  selectedTurnId,
  onSelectTurn,
}: {
  traces: TurnTrace[];
  // Kept for API stability; the rollup is derived from traces.
  summary?: TraceSummary | null;
  rateLimits: RateLimitView | null;
  liveUsage?: TurnUsage | null;
  // Kept for API stability; per-turn timing lives in the trace card.
  timings?: TurnTiming[];
  agents?: SubAgent[];
  skewMs?: number;
  // Optional, owned by the panel's scope switch.
  scope?: "turn" | "session";
  selectedTurnId?: string | null;
  onSelectTurn?: (turnId: string) => void;
}) {
  const limits = limitsVM(rateLimits);
  const latest = traces.at(-1);
  const ctx = contextVM(liveUsage ?? latest?.usage ?? null);

  if (!traces.length && !liveUsage && !limits.length)
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

  if (scope === "turn") {
    const turnId = selectedTurnId ?? latest?.turnId;
    const slice = turnId ? turnSliceVM(traces, turnId) : null;
    const trace = traces.find((t) => t.turnId === turnId);
    return (
      <div className="ob-insights">
        {slice ? (
          <div className="pn-mini" aria-label="Insights this turn">
            <div className="pn-h">
              <ObIcon name="chart" sm />
              Insights · {slice.label}
              <span className="spacer" />
              <em>trace</em>
            </div>
            <KV rows={slice.kv} />
          </div>
        ) : (
          <p className="muted sm">This turn has no trace yet.</p>
        )}
        {trace && <Privacy reports={[trace.privacy]} title="Privacy on this turn" />}
      </div>
    );
  }

  const vm = sessionVM(traces, { live: liveUsage, selectedTurnId });
  return (
    <div className="ob-insights">
      <div className="stats">
        {vm.stats.map((s) => (
          <div key={s.label}>
            <span className="v">{s.value}</span>
            <span className="l">{s.label}</span>
          </div>
        ))}
      </div>

      {vm.columns.length > 0 && (
        <>
          <div className="pn-h">
            Tokens per turn
            <span className="spacer" />
            <em>max {vm.chartMax}</em>
          </div>
          <div>
            <div
              className="pn-chart"
              role="img"
              aria-label={vm.chartLabel}
              style={{ gridTemplateColumns: `repeat(${vm.columns.length},minmax(0,1fr))` }}
            >
              {vm.columns.map((c) => {
                const cls = `pn-col${c.on ? " on" : ""}${c.live ? " live" : ""}`;
                const bar = <i style={{ height: `${c.height}%` }} />;
                return onSelectTurn && !c.live ? (
                  <button
                    key={c.id}
                    type="button"
                    className={cls}
                    aria-pressed={c.on}
                    aria-label={`${c.label}, ${c.value} tokens`}
                    onClick={() => onSelectTurn(c.id)}
                    style={colButton}
                  >
                    <b>{c.value}</b>
                    {bar}
                  </button>
                ) : (
                  <div key={c.id} className={cls}>
                    <b>{c.value}</b>
                    {bar}
                  </div>
                );
              })}
            </div>
            <div
              className="pn-axis"
              aria-hidden="true"
              style={{ gridTemplateColumns: `repeat(${vm.columns.length},minmax(0,1fr))` }}
            >
              {vm.columns.map((c) => (
                <span key={c.id}>{c.label}</span>
              ))}
            </div>
          </div>
        </>
      )}

      <KV rows={vm.kv} />

      {ctx && (
        <>
          <div className="pn-h">
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
              <b>{ctx.text}</b>Main agent, latest turn. Warns at 75%.
            </p>
          </div>
        </>
      )}

      {limits.length > 0 && (
        <>
          <div className="pn-h">
            <ObIcon name="key" sm />
            Account limits
          </div>
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
        </>
      )}

      <Privacy reports={traces.map((t) => t.privacy)} title="Privacy this session" />
    </div>
  );
}

// Buttons carry the column layout; reset native button chrome only.
const colButton: CSSProperties = {
  border: 0,
  padding: 0,
  background: "none",
  font: "inherit",
  cursor: "pointer",
};

function KV({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <div className="pn-kv">
      {rows.map((r) => (
        <span key={r.label} style={{ display: "contents" }}>
          <span>{r.label}</span>
          <b>{r.value}</b>
        </span>
      ))}
    </div>
  );
}

function Privacy({
  reports,
  title,
}: {
  reports: TurnTrace["privacy"][];
  title: string;
}) {
  const vm = privacyVM(reports);
  if (!vm.findings.length) return null;
  return (
    <>
      <div className="pn-h">
        <ObIcon name="shield" sm />
        {title}
        <span className="spacer" />
        <em>{vm.summary}</em>
      </div>
      {vm.findings.map((f) => (
        <div className="ob-find" key={f.key}>
          <span className="ob-tile">
            <ObIcon name="shield" />
          </span>
          <div className="ob-find-main">
            <span>
              <b>{f.kind}</b>
              <code aria-label={`Masked sample ${f.sample}`}>{f.sample}</code>
            </span>
            <span>
              <ObIcon name="file" sm />
              {f.source}
            </span>
          </div>
          <span className="ob-cnt">{f.count}</span>
        </div>
      ))}
    </>
  );
}

// Goal tab: budget split by turn, to scale of the budget. Selected turn solid,
// live turn striped. For the panel agent's Goal tab.
export function BudgetByTurn({
  traces,
  budget,
  liveUsage,
  selectedTurnId,
}: {
  traces: TurnTrace[];
  budget: number;
  liveUsage?: TurnUsage | null;
  selectedTurnId?: string | null;
}) {
  const vm = budgetByTurnVM(traces, budget, { live: liveUsage, selectedTurnId });
  if (!vm) return null;
  return (
    <>
      <div className="pn-h">Budget by turn</div>
      <div className="pn-budget" role="img" aria-label={vm.label}>
        {vm.segments.map((s) => (
          <i
            key={s.id}
            className={s.on ? "on" : s.live ? "live" : undefined}
            style={{ width: `${s.width}%` }}
          />
        ))}
      </div>
    </>
  );
}
