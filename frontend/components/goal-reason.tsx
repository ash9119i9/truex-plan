"use client";
import { errorReasons, providerTip, type TurnFailure } from "@/lib/goal-errors";

// Why the goal stopped, shown next to Codex's goal status.
export function GoalReason({
  failure,
  provider,
}: {
  failure: TurnFailure;
  provider?: string;
}) {
  const info = errorReasons[failure.reason];
  const tip = providerTip(provider, failure.reason);
  return (
    <div className="goal-reason" role="status">
      <p>
        <span className="goal-reason-label">
          {info.label}
          {failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ""}
        </span>{" "}
        {failure.reason === "other" ? failure.message : info.hint}
      </p>
      {tip && <p className="goal-reason-tip">{tip}</p>}
    </div>
  );
}
