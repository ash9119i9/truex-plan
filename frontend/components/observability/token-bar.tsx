"use client";
import { tokensVM } from "@/lib/vm-insights";
import type { TokenCounts, TurnUsage } from "../../../shared/contracts";

// Stacked bar to scale with a legend (input, cached input, output, reasoning),
// then a thin bar splitting the same total by agent. Helper usage is reported
// as one sum, so helpers share one segment.
export function TokenBar({
  usage,
  helperUsage,
}: {
  usage: TurnUsage | null;
  helperUsage?: TokenCounts | null;
}) {
  const vm = tokensVM({
    usage,
    helperUsage: helperUsage ?? null,
  } as Parameters<typeof tokensVM>[0]);
  if (!vm || !vm.total)
    return <p className="ob-oneline">Token usage was not reported for this turn.</p>;
  const alt = vm.parts.map((p) => `${p.label} ${p.text}, ${p.pct}`).join("; ");
  return (
    <>
      <div className="ob-stack" role="img" aria-label={`Tokens: ${alt}`}>
        {vm.parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <i key={p.key} className={`ob-t-${p.key}`} style={{ flexGrow: p.value }} />
          ))}
      </div>
      <div className="ob-leg">
        {vm.parts.map((p) => (
          <Legend key={p.key} tone={`ob-t-${p.key}`} label={p.label} value={p.text} pct={p.pct} />
        ))}
        <span />
        <span className="ob-tot">Total</span>
        <b>{vm.totalText}</b>
        <em />
      </div>
      {vm.helpersText && (
        <>
          <div
            className="ob-stack thin"
            role="img"
            aria-label={`By agent: ${vm.agents.map((a) => `${a.label} ${a.text}`).join(", ")}`}
          >
            {vm.agents.map((a) => (
              <i key={a.key} className={`ob-tv ${a.tone}`} style={{ flexGrow: a.value }} />
            ))}
          </div>
          <div className="ob-agents">
            {vm.agents.map((a) => (
              <span key={a.key} className={a.tone}>
                <i />
                {a.label} <b>{a.text}</b>
              </span>
            ))}
            <span>
              <b>{vm.helpersText}</b> from helpers
            </span>
          </div>
        </>
      )}
    </>
  );
}

function Legend({
  tone,
  label,
  value,
  pct,
}: {
  tone: string;
  label: string;
  value: string;
  pct: string;
}) {
  return (
    <>
      <i className={tone} />
      <span>{label}</span>
      <b>{value}</b>
      <em>{pct}</em>
    </>
  );
}
