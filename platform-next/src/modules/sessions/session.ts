import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ObjectId } from "mongodb";
import { parseWireId, toWireId } from "../../database/object-id";

// A sign-in on one browser. The refresh credential is never stored: only its
// SHA-256 hash, plus a few recently rotated hashes to recognize replay.
export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  refreshHash: string;
  previousRefreshHashes: { hash: string; rotatedAt: Date }[];
  generation: number;
  createdAt: Date;
  lastRefreshedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt?: Date;
  revokedReason?: SessionRevokeReason;
}

export type SessionRevokeReason =
  "logout" | "refresh_reuse" | "account_disabled";

export const SESSIONS_COLLECTION = "auth_sessions";

const SECRET_BYTES = 32;
// "<session id>.<43-character base64url secret>"
const CREDENTIAL = /^([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;

export interface RefreshCredential {
  sessionId: ObjectId;
  secret: string;
}

export function newRefreshSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function formatRefreshCredential(credential: RefreshCredential): string {
  return `${toWireId(credential.sessionId)}.${credential.secret}`;
}

export function parseRefreshCredential(
  value: unknown,
): RefreshCredential | null {
  if (typeof value !== "string") return null;
  const match = CREDENTIAL.exec(value);
  const sessionId = match ? parseWireId(match[1]) : null;
  return sessionId && match ? { sessionId, secret: match[2]! } : null;
}

export function hashRefreshSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isLive(session: SessionDoc, now: Date): boolean {
  return (
    session.revokedAt === undefined &&
    session.idleExpiresAt > now &&
    session.absoluteExpiresAt > now
  );
}
