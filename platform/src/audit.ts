import { ApiError } from "./errors";
import type { Store } from "./store";
import { log } from "../../shared/logging";

// Security audit trail (catalog collection `security_audit`).
//
// Records who read another person's private content, and who changed
// privileges or workspace policy. It never holds message text, prompts,
// cookies, invite links, OAuth claims or credentials: identifiers, the action
// and the outcome only. Rows expire after AUDIT_RETENTION_DAYS (365 by
// default). The collection is for operators; restrict it with database
// roles, since the application cannot do that for you.

export interface AuditEvent {
  actor: string;
  actorRole: string;
  action: string;
  tenantId: string;
  target?: { type: string; id: string; ownerId?: string };
  outcome?: string;
  requestId?: string;
  detail?: Record<string, string | number | boolean>;
}

const DAY = 86_400_000;
/** Identical reads inside one window are counted in one row, not stored again. */
const WINDOW_MS = 5 * 60_000;

export function auditRetentionMs(env: NodeJS.ProcessEnv = process.env) {
  const days = Number(env.AUDIT_RETENTION_DAYS);
  return (
    (Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 365) * DAY
  );
}

/**
 * Writes the event or throws. Used where disclosure must not happen without
 * the evidence: the caller turns a failure into AUDIT_UNAVAILABLE (503).
 */
export async function recordAudit(
  store: Store,
  event: AuditEvent,
  now = new Date(),
) {
  const window = Math.floor(now.getTime() / WINDOW_MS);
  const key = [
    event.actor,
    event.action,
    event.tenantId,
    event.target?.type ?? "",
    event.target?.id ?? "",
    event.outcome ?? "ok",
    window,
  ].join("|");
  await store.audit.updateOne(
    { _id: key },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        at: now,
        expiresAt: new Date(now.getTime() + auditRetentionMs()),
        actor: event.actor,
        actorRole: event.actorRole,
        action: event.action,
        tenantId: event.tenantId,
        ...(event.target ? { target: event.target } : {}),
        outcome: event.outcome ?? "ok",
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
      },
    },
    { upsert: true },
  );
}

/** Mandatory audit: no row, no disclosure. */
export async function requireAudit(store: Store, event: AuditEvent) {
  try {
    await recordAudit(store, event);
  } catch (error) {
    log("error", "audit write failed; refusing the request", {
      action: event.action,
      tenantId: event.tenantId,
      actor: event.actor,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(
      503,
      "This content cannot be shown right now because the access could not be recorded. Try again shortly.",
      "AUDIT_UNAVAILABLE",
    );
  }
}

/**
 * For changes that have already happened (a role change, a removal): the audit
 * row is best effort here, and a failure falls back to an error-level log that
 * carries the same fields, so the change is still traceable.
 */
export async function auditAfter(store: Store, event: AuditEvent) {
  try {
    await recordAudit(store, event);
  } catch (error) {
    log("error", "audit write failed", {
      ...event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
