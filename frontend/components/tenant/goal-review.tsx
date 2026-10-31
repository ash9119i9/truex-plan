"use client";
import { useEffect, useRef, useState } from "react";
import {
  canAcceptAsIs,
  formatTokensCompact,
  MAX_GOAL_OBJECTIVE,
  mergedObjectiveLength,
  raiseOptions,
  type GoalAction,
  type TenantGoal,
} from "@/lib/tenant-goal";
import { Button } from "@/components/tx/button";
import { Field, TextArea } from "@/components/tx/field";
import { Segmented } from "@/components/tx/segmented";

const WORKING: Partial<Record<GoalAction["kind"], string>> = {
  approve: "Approving…",
  accept: "Accepting…",
  changes: "Sending…",
  raise: "Raising…",
};

const KEEP = "keep";

// The owner's review of a goal, inside the goal card. Waiting for review:
// Approve, or Request changes with feedback and an optional higher budget.
// Out of budget: Raise budget, or at the chat's maximum Accept as is (Clear
// is on the card). Renders nothing otherwise.
export function GoalReview({
  goal,
  presets,
  maxTokenBudget,
  working,
  error = "",
  feedback: feedbackAtFirst = "",
  onAction,
}: {
  goal: TenantGoal;
  presets: readonly number[];
  maxTokenBudget: number;
  working: GoalAction["kind"] | null;
  /** The card's refusal; a refused request keeps the feedback. */
  error?: string;
  feedback?: string;
  onAction: (action: GoalAction) => void;
}) {
  const [feedback, setFeedback] = useState(feedbackAtFirst);
  const [raise, setRaise] = useState(KEEP);
  const was = useRef(working);
  useEffect(() => {
    if (was.current === "changes" && working === null && !error) {
      setFeedback("");
      setRaise(KEEP);
    }
    was.current = working;
  }, [working, error]);

  const busy = working !== null;
  const label = (kind: GoalAction["kind"]) =>
    working === kind ? WORKING[kind] : undefined;
  const higher = raiseOptions(goal, presets, maxTokenBudget);

  if (goal.status === "complete" && goal.review === "pending") {
    const length = mergedObjectiveLength(goal.objective, feedback);
    const over = length > MAX_GOAL_OBJECTIVE;
    const ready = !!feedback.trim() && !over;
    return (
      <form
        className="gc-review"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          onAction({
            kind: "changes",
            feedback: feedback.trim(),
            ...(raise !== KEEP ? { tokenBudget: Number(raise) } : {}),
          });
        }}
      >
        <div className="gc-row">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            working={label("approve")}
            onClick={() => onAction({ kind: "approve" })}
          >
            Approve
          </Button>
        </div>
        <Field
          label="Changes to make"
          error={
            over
              ? `The objective with your feedback would be ${length.toLocaleString("en-US")} characters; the limit is 4,000. Shorten the feedback.`
              : null
          }
          hint={
            <span className="gd-count">
              {`${length.toLocaleString("en-US")} / 4,000 characters with the objective`}
            </span>
          }
        >
          {(control) => (
            <TextArea
              {...control}
              rows={3}
              value={feedback}
              readOnly={busy}
              onChange={(e) => setFeedback(e.target.value)}
            />
          )}
        </Field>
        {higher.length > 0 && (
          <Segmented
            label="Budget for the changes"
            size="sm"
            options={[
              { value: KEEP, label: "Keep budget", disabled: busy },
              ...higher.map((budget) => ({
                value: String(budget),
                label: `${formatTokensCompact(budget)} tokens`,
                disabled: busy,
              })),
            ]}
            value={raise}
            onChange={setRaise}
          />
        )}
        <div className="gc-row">
          <Button
            type="submit"
            size="sm"
            disabled={!ready}
            working={label("changes")}
          >
            Request changes
          </Button>
        </div>
      </form>
    );
  }

  if (goal.status === "budgetLimited") {
    const accept = canAcceptAsIs(goal, maxTokenBudget);
    if (!accept && higher.length === 0) return null;
    return (
      <div className="gc-review">
        <div className="gc-row">
          {accept ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              working={label("accept")}
              onClick={() => onAction({ kind: "accept" })}
            >
              Accept as is
            </Button>
          ) : (
            higher.map((budget) => (
              <Button
                key={budget}
                size="sm"
                disabled={busy}
                onClick={() => onAction({ kind: "raise", tokenBudget: budget })}
              >
                {`Raise to ${formatTokensCompact(budget)} tokens`}
              </Button>
            ))
          )}
        </div>
      </div>
    );
  }

  return null;
}
