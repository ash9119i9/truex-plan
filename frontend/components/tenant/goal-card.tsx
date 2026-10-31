"use client";
import { useEffect, useRef, useState } from "react";
import {
  formatGoalElapsed,
  formatTokensCompact,
  goalActions,
  goalStatusText,
  isProposed,
  objectiveProblem,
  type GoalAction,
  type TenantGoal,
} from "@/lib/tenant-goal";
import { Button } from "@/components/tx/button";
import { Field, TextArea } from "@/components/tx/field";
import { Meter } from "@/components/tx/meter";
import { GoalReview } from "./goal-review";

const WORKING: Partial<Record<GoalAction["kind"], string>> = {
  pause: "Pausing…",
  resume: "Resuming…",
  clear: "Clearing…",
  edit: "Saving…",
  start: "Starting…",
};

// The chat's goal, pinned above the composer: the specified .pt-goal strip
// (objective, token meter, time) with the status in Codex's words and the
// owner's actions. Every action goes through onAction; the screen calls the
// platform and passes back `working` and any refusal as `error`.
export function GoalCard({
  goal,
  presets,
  maxTokenBudget = 0,
  working,
  error,
  prompt,
  confirming: confirmingAtFirst = false,
  onAction,
  onDismissPrompt,
}: {
  goal: TenantGoal;
  /** The budgets a proposed goal can start with. */
  presets: readonly number[];
  /** The chat's goal maximum, for raising and Accept as is. */
  maxTokenBudget?: number;
  /** The action waiting for the platform, if any. */
  working: GoalAction["kind"] | null;
  error: string;
  /** Show "Resume paused goal?" (once per opening of the chat). */
  prompt: boolean;
  confirming?: boolean;
  onAction: (action: GoalAction) => void;
  onDismissPrompt: () => void;
}) {
  const [confirming, setConfirming] = useState(confirmingAtFirst);
  const [editing, setEditing] = useState<string | null>(null);
  // A saved objective closes the editor; a refused one keeps the text.
  const was = useRef(working);
  useEffect(() => {
    if (was.current === "edit" && working === null && !error) setEditing(null);
    was.current = working;
  }, [working, error]);
  const proposed = isProposed(goal);
  const can = goalActions(goal);
  const busy = working !== null;
  const label = (kind: GoalAction["kind"]) =>
    working === kind ? WORKING[kind] : undefined;
  const budget = goal.tokenBudget;
  const editProblem = editing === null ? null : objectiveProblem(editing);
  return (
    <section className="tx-card gc" aria-label="Goal">
      <div className="pt-goal">
        <span className="pt-goal-k">Goal</span>
        <span className="pt-goal-text" title={goal.objective}>
          {goal.objective}
        </span>
        {budget !== null && (
          <span className="pt-goal-meter">
            <Meter
              label="Goal tokens used"
              value={goal.tokensUsed}
              max={budget}
              tone={
                goal.status === "budgetLimited"
                  ? "warn"
                  : goal.status === "complete"
                    ? "ok"
                    : "signal"
              }
              valueText={`${formatTokensCompact(goal.tokensUsed)} of ${formatTokensCompact(budget)} tokens`}
            />
          </span>
        )}
        <span className="pt-goal-num">
          {formatGoalElapsed(goal.timeUsedSeconds)}
        </span>
      </div>
      <div className="gc-body">
        <p className="gc-status">
          {proposed
            ? "The agent proposed a goal. Choose a budget to start."
            : goalStatusText(goal)}
        </p>
        {maxTokenBudget > 0 && !editing && !confirming && (
          <GoalReview
            goal={goal}
            presets={presets}
            maxTokenBudget={maxTokenBudget}
            working={working}
            error={error}
            onAction={onAction}
          />
        )}
        {prompt && can.resume && (
          <div className="gc-row">
            <span className="gc-ask">Resume paused goal?</span>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              working={label("resume")}
              onClick={() => onAction({ kind: "resume" })}
            >
              Resume
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismissPrompt}>
              Not now
            </Button>
          </div>
        )}
        {editing !== null ? (
          <form
            className="gc-edit"
            onSubmit={(e) => {
              e.preventDefault();
              if (!editProblem && !busy)
                onAction({ kind: "edit", objective: editing });
            }}
          >
            <Field
              label="Objective"
              error={editing.trim() ? editProblem : null}
            >
              {(control) => (
                <TextArea
                  {...control}
                  rows={3}
                  autoFocus
                  value={editing}
                  readOnly={busy}
                  onChange={(e) => setEditing(e.target.value)}
                />
              )}
            </Field>
            <div className="gc-row">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={!!editProblem}
                working={label("edit")}
              >
                Save objective
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : confirming ? (
          <div className="gc-row">
            <span className="gc-ask">End goal mode in this chat?</span>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              working={label("clear")}
              onClick={() => onAction({ kind: "clear" })}
            >
              Clear goal
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep goal
            </Button>
          </div>
        ) : (
          <div className="gc-row">
            {proposed &&
              presets.map((preset) => (
                <Button
                  key={preset}
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onAction({ kind: "start", tokenBudget: preset })
                  }
                >
                  {`Start with ${formatTokensCompact(preset)} tokens`}
                </Button>
              ))}
            {can.pause && (
              <Button
                size="sm"
                disabled={busy}
                working={label("pause")}
                onClick={() => onAction({ kind: "pause" })}
              >
                Pause
              </Button>
            )}
            {can.resume && !prompt && (
              <Button
                size="sm"
                disabled={busy}
                working={label("resume")}
                onClick={() => onAction({ kind: "resume" })}
              >
                Resume
              </Button>
            )}
            {can.edit && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(goal.objective)}
              >
                Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Clear
            </Button>
          </div>
        )}
        {error && (
          <p className="idd-note is-bad" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
