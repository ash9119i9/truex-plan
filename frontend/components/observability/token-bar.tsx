"use client";
import {
  contextFraction,
  formatPercent,
  formatTokens,
  splitTokens,
  tokenSegments,
} from "@/lib/observability";
import type { TokenCounts, TurnUsage } from "../../../shared/contracts";
import { Meter, StackedBar } from "./charts";

const tones: Record<(typeof tokenSegments)[number]["key"], string> = {
  newInput: "seg-new",
  cached: "seg-cached",
  output: "seg-output",
  reasoning: "seg-reasoning",
};

// What the turn used: input split into new and cached, output into reply and
// reasoning, plus how full the context window is.
export function TokenBar({
  usage,
  helperUsage,
}: {
  usage: TurnUsage | null;
  helperUsage?: TokenCounts | null;
}) {
  if (!usage)
    return <p className="tc-empty">Token usage was not reported for this turn.</p>;
  const split = splitTokens(usage);
  const context = contextFraction(usage);
  return (
    <div className="tc-section">
      <StackedBar
        label="Tokens this turn"
        format={formatTokens}
        segments={tokenSegments.map((s) => ({
          key: s.key,
          label: s.label,
          value: split[s.key],
          tone: tones[s.key],
        }))}
      />
      {!!helperUsage?.totalTokens && (
        <p className="tc-note">
          Helpers used another {formatTokens(helperUsage.totalTokens)} tokens.
        </p>
      )}
      {context !== null && (
        <Meter
          value={context}
          label="Context window"
          caption={`${formatPercent(context)} of context`}
          detail={`${formatTokens(usage.contextUsedTokens ?? 0)} of ${formatTokens(usage.contextWindow ?? 0)} tokens`}
        />
      )}
    </div>
  );
}
