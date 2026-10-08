import type {
  AutomationDefinition,
  AutomationRecipe,
  AutomationRun,
  AutomationRunStatus,
  AutomationReasonCode,
  AutomationTrigger,
} from "../../shared/automations.ts";
import { validateAutomationRecipe } from "../../shared/automations.ts";
import { api } from "./api.ts";

export type AutomationRunView = AutomationRun & { unread?: boolean };
export type AutomationView = AutomationDefinition & {
  recipe: AutomationRecipe;
  activeRunId?: string;
  latestRun?: AutomationRunView;
  unreadCount?: number;
};
export interface AutomationRunDetail {
  run: AutomationRunView;
  events: {
    id: string;
    type: string;
    at: string;
    persistedAt: string;
    detail: Record<string, unknown>;
  }[];
  output?: { text: string; sessionId: string };
  recipe: AutomationRecipe;
  eventsTruncated?: boolean;
  plan?: { steps: { step: string; status: string }[]; explanation?: string };
}

export function automationAttentionCount(automation: {
  unreadCount?: number;
  latestRun?: { unread?: boolean };
}): number {
  return automation.unreadCount ?? (automation.latestRun?.unread ? 1 : 0);
}

export interface AutomationFields {
  name: string;
  agentId: string;
  prompt: string;
  projectId: string;
  triggerKind: "interval" | "calendar";
  intervalAmount: string;
  intervalUnit: "minutes" | "hours" | "days";
  anchorAt: string;
  weekdays: number[];
  localTime: string;
  timeZone: string;
  executionMinutes: string;
  latenessMinutes: string;
}

export function defaultAutomationFields(
  agentId = "",
  timeZone = "UTC",
  now = new Date().toISOString(),
): AutomationFields {
  return {
    name: "",
    agentId,
    prompt: "",
    projectId: "",
    triggerKind: "interval",
    intervalAmount: "1",
    intervalUnit: "hours",
    anchorAt: now.slice(0, 19),
    weekdays: [1, 2, 3, 4, 5],
    localTime: "09:00",
    timeZone,
    executionMinutes: "30",
    latenessMinutes: "10",
  };
}

export function fieldsFromRecipe(recipe: AutomationRecipe): AutomationFields {
  const fields = defaultAutomationFields(
    recipe.agentId,
    recipe.trigger.timeZone,
  );
  const trigger = recipe.trigger;
  return {
    ...fields,
    name: recipe.name,
    prompt: recipe.prompt,
    projectId: recipe.projectId ?? "",
    triggerKind: trigger.kind,
    executionMinutes: String(recipe.limits.executionTimeoutMs / 60_000),
    latenessMinutes: String(recipe.limits.latenessGraceMs / 60_000),
    ...(trigger.kind === "interval"
      ? {
          intervalAmount: String(trigger.everyMs / 60_000),
          intervalUnit: "minutes" as const,
          anchorAt: trigger.anchorAt.slice(0, 19),
        }
      : { weekdays: trigger.weekdays, localTime: trigger.localTime }),
  };
}

export function recipeFromFields(fields: AutomationFields): AutomationRecipe {
  const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  const trigger =
    fields.triggerKind === "interval"
      ? {
          kind: "interval",
          everyMs: Number(fields.intervalAmount) * unitMs[fields.intervalUnit],
          anchorAt: `${fields.anchorAt.length === 16 ? fields.anchorAt + ":00" : fields.anchorAt}Z`,
          timeZone: fields.timeZone,
        }
      : {
          kind: "calendar",
          weekdays: fields.weekdays,
          localTime: fields.localTime,
          timeZone: fields.timeZone,
        };
  return validateAutomationRecipe({
    name: fields.name,
    agentId: fields.agentId,
    prompt: fields.prompt,
    ...(fields.projectId ? { projectId: fields.projectId } : {}),
    trigger,
    limits: {
      executionTimeoutMs: Number(fields.executionMinutes) * 60_000,
      latenessGraceMs: Number(fields.latenessMinutes) * 60_000,
    },
  });
}

type RunPermission = Pick<
  AutomationDefinition,
  "status" | "revision" | "enabledRevision"
> & { activeRunId?: string };
export function canRunAutomation(definition: RunPermission): boolean {
  return (
    definition.status === "enabled" &&
    definition.enabledRevision === definition.revision &&
    !definition.activeRunId
  );
}
export function canRetryAutomationRun(
  run: Pick<AutomationRun, "status" | "stopState">,
  definition: RunPermission,
): boolean {
  return (
    canRunAutomation(definition) &&
    ["failed", "cancelled", "skipped"].includes(run.status) &&
    ["not_started", "stopped"].includes(run.stopState)
  );
}
export function canRequestAutomationCancellation(
  run: Pick<AutomationRun, "status" | "stopState">,
): boolean {
  if (run.status === "cancellation_requested" || run.stopState === "stopped")
    return false;
  return (
    ["accepted", "preparing", "running"].includes(run.status) ||
    ["running", "unknown", "stop_requested"].includes(run.stopState)
  );
}

export const REASON_LABELS: Record<AutomationReasonCode, string> = {
  approval_required: "approval required",
  human_review_required: "human review required",
  input_required: "required input missing",
  dependency_unavailable: "dependency unavailable",
  access_revoked: "access revoked",
  provider_failure: "provider failure",
  execution_timeout: "execution timed out",
  receipt_lost: "execution receipt unavailable",
  termination_unconfirmed: "termination unconfirmed",
  previous_run_active: "previous run still active",
  schedule_window_elapsed: "schedule window elapsed",
  stale_revision: "revision changed",
  automation_inactive: "automation inactive",
  result_missing: "result missing",
  result_invalid: "result did not meet the contract",
  runtime_failure: "runtime failure",
  audit_incomplete: "audit incomplete",
  user_cancelled: "cancelled by you",
};
export function runOutcomeLabel(
  run: Pick<AutomationRun, "status" | "reason">,
): string {
  const label: Record<AutomationRunStatus, string> = {
    accepted: "Accepted",
    preparing: "Preparing",
    running: "Running",
    cancellation_requested: "Cancellation requested",
    succeeded: "Succeeded",
    failed: "Failed",
    skipped: "Skipped",
    cancelled: "Cancelled",
    unknown: "Outcome unknown — review required",
  };
  return (
    label[run.status] +
    (run.reason
      ? ` — ${REASON_LABELS[run.reason] ?? run.reason.replaceAll("_", " ")}`
      : "")
  );
}
export function repairInstruction(
  run: Pick<AutomationRun, "reason" | "status" | "stopState">,
): string {
  if (
    run.status === "unknown" ||
    !["stopped", "not_started"].includes(run.stopState)
  )
    return "Wait for confirmed termination and reconciliation before starting another run. Known actions may already have taken effect.";
  if (
    ["approval_required", "human_review_required", "input_required"].includes(
      run.reason ?? "",
    )
  )
    return "Review the missing decision or input, update the recipe scope, and explicitly enable its new revision before retrying.";
  if (["dependency_unavailable", "access_revoked"].includes(run.reason ?? ""))
    return "Restore the required connection, input, or access. The next occurrence rechecks current permissions; you can also start a linked retry.";
  return "Review the recorded actions and output, correct the cause, then start a new linked run. Completed actions are preserved.";
}
export function formatAutomationTime(
  instant?: string,
  timeZone = "UTC",
): string {
  if (!instant || !Number.isFinite(Date.parse(instant))) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
  }).format(new Date(instant));
}
export function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.kind === "interval")
    return `Every ${trigger.everyMs / 60_000} minutes · ${trigger.timeZone}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${trigger.weekdays.map((d) => days[d]).join(", ")} at ${trigger.localTime} · ${trigger.timeZone}`;
}

export interface AutomationHistoryFilters {
  status?: string;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
}
export function historyQuery(filters: AutomationHistoryFilters = {}): string {
  const query = new URLSearchParams();
  for (const key of ["status", "from", "to", "before", "limit"] as const)
    if (filters[key] !== undefined && filters[key] !== "")
      query.set(key, String(filters[key]));
  return query.size ? `?${query}` : "";
}
const path = (id: string) => `/api/automations/${encodeURIComponent(id)}`;
const runPath = (id: string, runId: string) =>
  `${path(id)}/runs/${encodeURIComponent(runId)}`;
export const listAutomations = (): Promise<{
  available: boolean;
  items: AutomationView[];
}> => api("/api/automations");
export const createAutomation = (
  recipe: AutomationRecipe,
): Promise<AutomationView> => api("/api/automations", recipe);
export const editAutomation = (
  id: string,
  version: number,
  recipe: AutomationRecipe,
): Promise<AutomationView> => api(path(id), { version, recipe }, "PUT");
export const getAutomation = (id: string): Promise<AutomationView> =>
  api(path(id));
export const controlAutomation = (
  id: string,
  version: number,
  action: "enable" | "pause" | "resume" | "archive",
): Promise<AutomationView> => api(`${path(id)}/control`, { version, action });
export const previewAutomation = (
  trigger: AutomationTrigger,
): Promise<{ times: string[]; dstPolicy: "native" }> =>
  api("/api/automations/preview", { trigger });
export const runAutomation = (
  id: string,
  requestKey: string,
  revision: number,
  retryOfRunId?: string,
): Promise<AutomationRunView> =>
  api(`${path(id)}/runs`, {
    requestKey,
    revision,
    ...(retryOfRunId ? { retryOfRunId } : {}),
  });
export const listAutomationRuns = (
  id: string,
  filters: AutomationHistoryFilters = {},
): Promise<{ items: AutomationRunView[]; nextCursor?: string }> =>
  api(`${path(id)}/runs${historyQuery(filters)}`);
export const getAutomationRun = (
  id: string,
  runId: string,
): Promise<AutomationRunDetail> => api(runPath(id, runId));
export const cancelAutomationRun = (
  id: string,
  runId: string,
): Promise<AutomationRunView> => api(`${runPath(id, runId)}/cancel`, {});
export const readAutomationRun = (
  id: string,
  runId: string,
): Promise<unknown> => api(`${runPath(id, runId)}/read`, {});
export const automationExportHref = (
  id: string,
  filters: AutomationHistoryFilters = {},
) => `${path(id)}/export.csv${historyQuery(filters)}`;
