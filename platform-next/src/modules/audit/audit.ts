import type { ObjectId } from "mongodb";

export type AuditResult = "success" | "denied" | "failed";

export type AuditActor =
  { kind: "operator"; name: string } | { kind: "user"; userId: ObjectId };

// A security-relevant action. Details hold small scalar facts only: never
// secrets, tokens or chat content.
export interface AuditEvent {
  action: string;
  actor: AuditActor;
  result: AuditResult;
  tenantId?: ObjectId;
  targetUserId?: ObjectId;
  reason?: string;
  details?: Record<string, string | number | boolean | null>;
  requestId?: string;
}

export interface AuditDoc extends AuditEvent {
  _id: ObjectId;
  at: Date;
}

export const AUDIT_COLLECTION = "security_audit";
