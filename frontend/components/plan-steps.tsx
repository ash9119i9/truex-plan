import { planProgress, stepStatus, type PlanStep } from "@/lib/plan";
import { Icon } from "./v2/icon";

// Spec 5a labels. Status is shown by mark and text, never by color alone.
const labels = {
  completed: "Done",
  inProgress: "In progress",
  pending: "Pending",
} as const;

// The mark shared by plan steps and goal checkpoints: check when done,
// spinner for the current step, a small dot while pending.
export function StepMark({ state }: { state: "done" | "current" | "pending" }) {
  return (
    <span
      className={`step-mark${state === "done" ? " is-done" : ""}`}
      aria-hidden="true"
    >
      {state === "done" ? (
        <Icon name="check" size={11} stroke={2.5} />
      ) : state === "current" ? (
        <span className="spinner" />
      ) : (
        <span className="cp-dot" />
      )}
    </span>
  );
}

// Read-only list of plan steps; the current step is marked for assistive tech.
export function PlanSteps({ plan }: { plan: PlanStep[] }) {
  const { current } = planProgress(plan);
  return (
    <ol className="pl-list">
      {plan.map((p, i) => {
        const status = stepStatus(p.status);
        const isCurrent = i === current;
        const done = status === "completed";
        return (
          <li
            key={i}
            className={`pl-item${done ? " is-done" : ""}${isCurrent ? " is-current" : ""}`}
            aria-current={isCurrent ? "step" : undefined}
          >
            <StepMark
              state={done ? "done" : isCurrent ? "current" : "pending"}
            />
            <div>
              <div className="pl-label">{p.step}</div>
              <div className="pl-status">
                {isCurrent && !done ? labels.inProgress : labels[status]}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
