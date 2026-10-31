"use client";
import { useId } from "react";
import {
  formatTokensCompact,
  MAX_GOAL_OBJECTIVE,
  objectiveLength,
  objectiveProblem,
} from "@/lib/tenant-goal";
import { Button } from "@/components/tx/button";
import { Field, TextArea } from "@/components/tx/field";
import { Segmented } from "@/components/tx/segmented";

// Starting a goal: the objective and one of the workspace's budgets. Only
// the goal strip is designed (backlog/frontend-redesign/21), so this is the
// system's dialog pieces restyled. A refusal stays in the dialog with the
// text kept, so nothing typed is lost.
export function GoalDialog({
  presets,
  objective,
  onObjective,
  budget,
  onBudget,
  error,
  starting,
  onStart,
  onCancel,
}: {
  presets: readonly number[];
  objective: string;
  onObjective: (text: string) => void;
  budget: number;
  onBudget: (budget: number) => void;
  /** The platform's refusal, shown until the next try. */
  error: string;
  starting: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const length = objectiveLength(objective);
  // Empty is not an error yet: Start just stays off.
  const problem = objective.trim() ? objectiveProblem(objective) : null;
  const ready = !objectiveProblem(objective) && presets.includes(budget);
  const cancel = () => {
    if (!starting) onCancel();
  };
  return (
    <div className="idd-scrim" onMouseDown={cancel}>
      <div
        className="gd"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) cancel();
        }}
      >
        <form
          className="idd-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !starting) onStart();
          }}
        >
          <header className="idd-head">
            <h2 id={titleId} className="t-h3">
              Set a goal
            </h2>
            <p className="idd-sub">
              The agent keeps working toward it, also while this tab is closed,
              until it is done or the budget is used.
            </p>
          </header>
          <div className="gd-body">
            <Field
              label="Objective"
              error={problem}
              hint={
                <span className="gd-count">
                  {length.toLocaleString("en-US")} /{" "}
                  {MAX_GOAL_OBJECTIVE.toLocaleString("en-US")}
                </span>
              }
            >
              {(control) => (
                <TextArea
                  {...control}
                  className="gd-objective"
                  rows={5}
                  autoFocus
                  value={objective}
                  readOnly={starting}
                  onChange={(e) => onObjective(e.target.value)}
                />
              )}
            </Field>
            <div className="gd-budget">
              <span className="gd-label" aria-hidden="true">
                Token budget
              </span>
              <Segmented
                label="Token budget"
                options={presets.map((preset) => ({
                  value: String(preset),
                  label: `${formatTokensCompact(preset)} tokens`,
                  disabled: starting,
                }))}
                value={String(budget)}
                onChange={(value) => onBudget(Number(value))}
              />
            </div>
          </div>
          {error && (
            <p className="idd-note is-bad idd-error" role="alert">
              {error}
            </p>
          )}
          <footer className="idd-foot">
            <span className="pt-spacer" />
            <Button size="lg" onClick={cancel} disabled={starting}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!ready}
              working={starting ? "Starting…" : undefined}
            >
              Start goal
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
