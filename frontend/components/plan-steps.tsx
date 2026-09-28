import { CheckCircle2, Circle, LoaderCircle } from "lucide-react";
import {
  planProgress,
  statusText,
  stepStatus,
  type PlanStep,
} from "@/lib/plan";

// Read-only list of plan steps. Status is shown by icon and text, never by
// color alone; the current step is marked for assistive tech too.
export function PlanSteps({ plan }: { plan: PlanStep[] }) {
  const { current } = planProgress(plan);
  return (
    <ol className="plan-steps">
      {plan.map((p, i) => {
        const status = stepStatus(p.status);
        const Icon =
          status === "completed"
            ? CheckCircle2
            : status === "inProgress"
              ? LoaderCircle
              : Circle;
        return (
          <li
            key={i}
            className={`plan-step plan-step-${status}${i === current ? " plan-step-current" : ""}`}
            aria-current={i === current ? "step" : undefined}
          >
            <Icon size={15} aria-hidden="true" className="plan-step-icon" />
            <span className="plan-step-text">{p.step}</span>
            <span className="plan-step-status">{statusText[status]}</span>
          </li>
        );
      })}
    </ol>
  );
}
