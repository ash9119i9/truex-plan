import type { DomainEvent, PendingRequest } from "../../shared/contracts";

export type PlanStatus = "pending" | "inProgress" | "completed";
export interface PlanStep {
  step: string;
  status: string;
}

// The question id and labels the planning instructions ask the model to use.
export const PLAN_APPROVAL_ID = "plan_approval";
export const APPROVE = "Approve";
export const REVISE = "Revise";

// Codex sends `inProgress`; tolerate the snake_case spelling models sometimes use.
export function stepStatus(status: string): PlanStatus {
  if (status === "completed") return "completed";
  if (status === "inProgress" || status === "in_progress") return "inProgress";
  return "pending";
}

export const statusText: Record<PlanStatus, string> = {
  pending: "Pending",
  inProgress: "In progress",
  completed: "Completed",
};

// Only a plan update or a snapshot replaces the plan; turn boundaries keep it
// so the sidebar still shows it while the next turn works through the steps.
export function applyPlanEvent(
  plan: PlanStep[],
  event: DomainEvent,
): PlanStep[] {
  if (event.type === "plan.updated" || event.type === "snapshot") {
    const next = (event.data as { plan?: unknown })?.plan;
    return Array.isArray(next) ? (next as PlanStep[]) : [];
  }
  return plan;
}

export function planProgress(plan: PlanStep[]) {
  const done = plan.filter((p) => stepStatus(p.status) === "completed").length;
  let current = plan.findIndex((p) => stepStatus(p.status) === "inProgress");
  // Between steps nothing is in progress; the next pending step is up next.
  if (current < 0 && done > 0 && done < plan.length)
    current = plan.findIndex((p) => stepStatus(p.status) === "pending");
  return {
    done,
    total: plan.length,
    current,
    label: plan.length ? `${done} of ${plan.length} done` : "",
  };
}

export function isPlanApproval(request: PendingRequest): boolean {
  if (request.method !== "item/tool/requestUserInput") return false;
  const questions = (request.detail?.questions || []) as { id?: string }[];
  return questions.some((q) => q?.id === PLAN_APPROVAL_ID);
}

export function awaitingApproval(pending: PendingRequest[]): boolean {
  return pending.some(isPlanApproval);
}

// Same shape as other request_user_input answers. Feedback rides along as a
// `user_note:` entry, the encoding Codex uses for notes on a picked option.
export function planApprovalPayload(
  choice: typeof APPROVE | typeof REVISE,
  feedback = "",
) {
  const note = choice === REVISE ? feedback.trim() : "";
  return {
    answers: {
      [PLAN_APPROVAL_ID]: {
        answers: note ? [choice, `user_note: ${note}`] : [choice],
      },
    },
  };
}
