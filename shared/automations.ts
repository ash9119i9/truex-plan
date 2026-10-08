/** Public automation contracts. Temporal receives identifiers, never recipe content. */
export const MIN_AUTOMATION_INTERVAL_MS = 60_000;
export const DEFAULT_AUTOMATION_LIMITS = Object.freeze({
  executionTimeoutMs: 30 * 60_000,
  latenessGraceMs: 10 * 60_000,
});

export type AutomationTrigger =
  | { kind: "interval"; everyMs: number; anchorAt: string; timeZone: string }
  | {
      kind: "calendar";
      /** Sunday is 0, Saturday is 6. Native Temporal DST semantics apply. */
      weekdays: number[];
      localTime: string;
      timeZone: string;
    };

export interface AutomationLimits {
  executionTimeoutMs: number;
  latenessGraceMs: number;
}

/** Restricted revision content; never a Temporal Workflow argument. */
export interface AutomationRecipe {
  name: string;
  agentId: string;
  prompt: string;
  projectId?: string;
  trigger: AutomationTrigger;
  limits: AutomationLimits;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${field} must be a nonempty string of at most ${max} characters`,
    );
  return value.trim();
}

function duration(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

/** Require a real UTC instant, rejecting Date's silent invalid-day normalization. */
function utcInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    throw new Error(`${field} must be a UTC ISO instant`);
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new Error(`${field} must be a valid UTC instant`);
  return date.toISOString();
}

function timezone(value: unknown): string {
  const timeZone = requiredString(value, "timeZone", 100);
  if (timeZone.startsWith("+") || timeZone.startsWith("-"))
    throw new Error("timeZone must be an IANA timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new Error("timeZone must be an IANA timezone");
  }
  return timeZone;
}

export function validateAutomationRecipe(value: unknown): AutomationRecipe {
  const input = object(value, "recipe");
  const spec = object(input.trigger, "trigger");
  let trigger: AutomationTrigger;
  if (spec.kind === "interval") {
    trigger = {
      kind: "interval",
      everyMs: duration(
        spec.everyMs,
        "everyMs",
        MIN_AUTOMATION_INTERVAL_MS,
        Number.MAX_SAFE_INTEGER,
      ),
      anchorAt: utcInstant(spec.anchorAt, "anchorAt"),
      timeZone: timezone(spec.timeZone),
    };
    if (trigger.everyMs % 1000 || !trigger.anchorAt.endsWith(".000Z"))
      throw new Error("Interval and anchor must use whole-second precision");
  } else if (spec.kind === "calendar") {
    if (
      !Array.isArray(spec.weekdays) ||
      spec.weekdays.length === 0 ||
      spec.weekdays.length > 7
    )
      throw new Error("weekdays must contain one to seven distinct days");
    const weekdays = spec.weekdays.map((day) => duration(day, "weekday", 0, 6));
    if (new Set(weekdays).size !== weekdays.length)
      throw new Error("weekdays must be distinct");
    const localTime = requiredString(spec.localTime, "localTime", 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime))
      throw new Error("localTime must be HH:mm");
    const timeZone = timezone(spec.timeZone);
    trigger = {
      kind: "calendar",
      weekdays: weekdays.sort((a, b) => a - b),
      localTime,
      timeZone,
    };
  } else throw new Error("trigger must be interval or calendar");
  const limits =
    input.limits === undefined
      ? DEFAULT_AUTOMATION_LIMITS
      : object(input.limits, "limits");
  requiredString(input.prompt, "prompt", 100_000);
  return {
    name: requiredString(input.name, "name", 120),
    agentId: requiredString(input.agentId, "agentId"),
    // Preserve reviewed prompt text, including intentional surrounding whitespace.
    prompt: input.prompt as string,
    ...(input.projectId === undefined
      ? {}
      : { projectId: requiredString(input.projectId, "projectId") }),
    trigger,
    limits: {
      executionTimeoutMs: duration(
        limits.executionTimeoutMs,
        "executionTimeoutMs",
        1,
        DEFAULT_AUTOMATION_LIMITS.executionTimeoutMs,
      ),
      latenessGraceMs: duration(
        limits.latenessGraceMs,
        "latenessGraceMs",
        0,
        DEFAULT_AUTOMATION_LIMITS.latenessGraceMs,
      ),
    },
  };
}

export type AutomationStatus = "draft" | "enabled" | "paused" | "archived";
export type AutomationSyncState = "pending" | "synced" | "error";
export type AutomationOutcome =
  "succeeded" | "failed" | "skipped" | "cancelled" | "unknown";
export type AutomationRunStatus =
  | "accepted"
  | "preparing"
  | "running"
  | "cancellation_requested"
  | AutomationOutcome;
/** Stop evidence is independent of business outcome, including a failed recipe. */
export type AutomationStopState =
  "not_started" | "running" | "stop_requested" | "stopped" | "unknown";
export type AutomationReasonCode =
  | "approval_required"
  | "human_review_required"
  | "input_required"
  | "dependency_unavailable"
  | "access_revoked"
  | "provider_failure"
  | "execution_timeout"
  | "receipt_lost"
  | "termination_unconfirmed"
  | "previous_run_active"
  | "schedule_window_elapsed"
  | "stale_revision"
  | "automation_inactive"
  | "result_missing"
  | "result_invalid"
  | "runtime_failure"
  | "audit_incomplete"
  | "user_cancelled";

export interface AutomationDefinition {
  id: string;
  tenantId: string;
  ownerId: string;
  revision: number;
  enabledRevision?: number;
  status: AutomationStatus;
  controlVersion: number;
  syncState: AutomationSyncState;
  appliedControlVersion?: number;
  nextScheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Immutable once persisted; edits append a new reviewed recipe revision. */
export interface AutomationRevision {
  id: string;
  automationId: string;
  tenantId: string;
  ownerId: string;
  revision: number;
  recipe: AutomationRecipe;
  createdAt: string;
  createdBy: string;
}

/** Authorized opaque reference; no payload, credential or provider URL. */
export interface AutomationContentReference {
  id: string;
  kind: "prompt" | "result" | "artifact";
  tenantId: string;
  ownerId: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  tenantId: string;
  ownerId: string;
  revision: number;
  source: "manual" | "scheduled";
  requestKey: string;
  workflowId: string;
  scheduledAt?: string;
  acceptedAt: string;
  startedAt?: string;
  completedAt?: string;
  status: AutomationRunStatus;
  outcome?: AutomationOutcome;
  reason?: AutomationReasonCode;
  stopState: AutomationStopState;
  sessionId?: string;
  /** Exact root turn, never a helper's terminal event. */
  turnId?: string;
  resultRef?: AutomationContentReference;
  auditComplete: boolean;
  model?: string;
  configurationFingerprint?: string;
  retryOfRunId?: string;
}

export interface AutomationWorkflowInput {
  tenantId: string;
  ownerId: string;
  automationId: string;
  runId: string;
  revision: number;
  controlVersion: number;
}

export function validateAutomationWorkflowInput(
  value: unknown,
): AutomationWorkflowInput {
  const input = object(value, "workflow input");
  const allowed = [
    "tenantId",
    "ownerId",
    "automationId",
    "runId",
    "revision",
    "controlVersion",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("workflow input contains unsupported or restricted fields");
  return {
    tenantId: requiredString(input.tenantId, "tenantId"),
    ownerId: requiredString(input.ownerId, "ownerId"),
    automationId: requiredString(input.automationId, "automationId"),
    runId: requiredString(input.runId, "runId"),
    revision: duration(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
    controlVersion: duration(
      input.controlVersion,
      "controlVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export type AutomationAuditKind =
  | "created"
  | "edited"
  | "enabled"
  | "paused"
  | "resumed"
  | "archived"
  | "run_now"
  | "cancel_requested"
  | "accepted"
  | "preparing"
  | "dispatched"
  | "dependency_checked"
  | "request_blocked"
  | "tool_started"
  | "tool_completed"
  | "root_completed"
  | "retry"
  | "outcome"
  | "stop_confirmed"
  | "audit_incomplete"
  | "sync_applied"
  | "sync_failed"
  | "missed_window";

/** Closed safe metadata shape; restricted messages/tool payloads use contentRefs. */
export interface AutomationAuditMetadata {
  reason?: AutomationReasonCode;
  attempt?: number;
  toolName?: string;
  connectorId?: string;
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  workflowId?: string;
  operationId?: string;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  windowStartAt?: string;
  windowEndAt?: string;
  missedCount?: number;
  dispatchLagMs?: number;
  durationMs?: number;
  controlVersion?: number;
  outcome?: AutomationOutcome;
  stopState?: AutomationStopState;
  effects?: "confirmed" | "unknown" | "none";
  modelFingerprint?: string;
}

export interface AutomationAuditEvent {
  id: string;
  tenantId: string;
  ownerId: string;
  automationId: string;
  runId?: string;
  revision: number;
  kind: AutomationAuditKind;
  occurredAt: string;
  persistedAt: string;
  actor: { kind: "owner" | "system" | "runtime"; id?: string };
  metadata: AutomationAuditMetadata;
  contentRefs?: AutomationContentReference[];
}

const RUN_TRANSITIONS: Record<
  AutomationRunStatus,
  readonly AutomationRunStatus[]
> = {
  accepted: [
    "preparing",
    "skipped",
    "failed",
    "cancellation_requested",
    "cancelled",
  ],
  preparing: [
    "running",
    "failed",
    "skipped",
    "cancellation_requested",
    "cancelled",
    "unknown",
  ],
  running: ["succeeded", "failed", "cancellation_requested", "unknown"],
  cancellation_requested: ["cancelled", "failed", "succeeded", "unknown"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
  // Reconciliation may resolve the same execution; it must never redispatch it.
  unknown: ["succeeded", "failed", "cancelled"],
};

export function assertAutomationRunTransition(
  from: AutomationRunStatus,
  to: AutomationRunStatus,
): void {
  if (from !== to && !RUN_TRANSITIONS[from].includes(to))
    throw new Error(`Invalid automation run transition: ${from} -> ${to}`);
}

export function canReleaseAutomationFence(
  stopState: AutomationStopState,
): boolean {
  return stopState === "not_started" || stopState === "stopped";
}
