import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

/** Only safe registry identifiers enter Temporal history. */
export interface AutomationOccurrenceInput {
  tenantId: string;
  automationId: string;
  revision: number;
  controlVersion: number;
  trigger: "scheduled" | "manual";
  requestId?: string;
  retryOfRunId?: string;
  scheduledAt?: string;
}
export interface AutomationRunReference {
  tenantId: string;
  automationId: string;
  runId: string;
}
export interface AutomationActivities {
  admitOccurrence(
    input: AutomationOccurrenceInput & {
      workflowId: string;
      workflowRunId: string;
    },
  ): Promise<{ runId: string; executionTimeoutMs: number } | null>;
  dispatchRun(input: AutomationRunReference): Promise<void>;
  observeRun(input: AutomationRunReference): Promise<{ terminal: boolean }>;
  stopRun(
    input: AutomationRunReference & {
      reason: "execution_timeout" | "cancelled" | "infrastructure_error";
    },
  ): Promise<void>;
}
const persistence = proxyActivities<AutomationActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "1 second",
    maximumInterval: "5 seconds",
  },
});
// Dispatch uncertainty is resolved by the adapter; Activity retries must not repeat native submission.
const execution = proxyActivities<AutomationActivities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 1 },
});
export const cancelAutomationRun = defineSignal("cancelAutomationRun");

export async function automationOccurrence(
  input: AutomationOccurrenceInput,
): Promise<{ runId: string } | null> {
  let cancelled = false;
  setHandler(cancelAutomationRun, () => {
    cancelled = true;
  });
  const info = workflowInfo();
  const nativeTime = info.searchAttributes.TemporalScheduledStartTime?.[0];
  const admitted = await persistence.admitOccurrence({
    ...input,
    ...(input.trigger === "scheduled" && nativeTime instanceof Date
      ? { scheduledAt: nativeTime.toISOString() }
      : {}),
    workflowId: info.workflowId,
    workflowRunId: info.runId,
  });
  if (!admitted) return null;
  const reference = {
    tenantId: input.tenantId,
    automationId: input.automationId,
    runId: admitted.runId,
  };
  const deadline = Date.now() + admitted.executionTimeoutMs;
  const stopRequested = condition(
    () => cancelled,
    admitted.executionTimeoutMs,
  ).then(() => ({ stopped: true as const }));
  async function bounded<T>(
    operation: Promise<T>,
  ): Promise<{ stopped: true } | { stopped: false; value: T }> {
    return Promise.race([
      operation.then((value) => ({ stopped: false as const, value })),
      stopRequested,
    ]);
  }
  let stopReason: "execution_timeout" | "infrastructure_error" =
    "execution_timeout";
  try {
    const dispatched = cancelled
      ? { stopped: true }
      : await bounded(execution.dispatchRun(reference));
    if (!dispatched.stopped) {
      while (!cancelled && Date.now() < deadline) {
        const observed = await bounded(persistence.observeRun(reference));
        if (observed.stopped) break;
        if (observed.value.terminal) return { runId: admitted.runId };
        await condition(
          () => cancelled,
          Math.min(2_000, deadline - Date.now()),
        );
      }
    }
  } catch {
    stopReason = "infrastructure_error";
  }
  await persistence.stopRun({
    ...reference,
    reason: cancelled ? "cancelled" : stopReason,
  });
  return { runId: admitted.runId };
}
