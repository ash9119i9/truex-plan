import type { DatabaseId } from "./configuration-documents";
import type { Session, TurnTrace } from "../../../shared/contracts";
import type { StoredPlan } from "./plans";
// One document per {sessionId, turnId}. Holds only the TurnTrace, which has no
// raw text (privacy findings are already masked).
export type TraceDocument = TurnTrace & { _id: string; sessionId: string };
export type SessionDocument = Session & { plan?: StoredPlan };
// Security audit trail (catalog, security_audit). Rows never hold message
// text, cookies, invite links or credentials; only who touched what and when.
export interface AuditDocument {
  _id: string;
  at: Date;
  expiresAt: Date;
  actor: string;
  actorRole: string;
  action: string;
  tenantId: string;
  target?: { type: string; id: string; ownerId?: string };
  outcome: string;
  requestId?: string;
  /** Repeated identical reads inside one window are counted, not duplicated. */
  count: number;
  detail?: Record<string, string | number | boolean>;
}
export interface DemoUsageDocument {
  /** `${utcDay}:${tenantId}:${userId | "*" | "signups"}` */
  _id: string;
  count: number;
  expiresAt: Date;
}
export interface DemoTurnDocument {
  _id: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  clientId: string;
  day: string;
  state: "reserved" | "released";
  at: Date;
  expiresAt: Date;
}
export interface SkillDocument {
  _id: DatabaseId;
  /** Folder name Codex sees; [a-z0-9-], unique in the catalog. */
  name: string;
  description: string;
  /** SKILL.md body (markdown, without front matter). */
  body: string;
  version: number;
  enabled?: boolean;
}
