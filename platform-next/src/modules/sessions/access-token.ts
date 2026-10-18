import { sign, verify } from "node:crypto";
import type { ObjectId } from "mongodb";
import type { AuthConfig } from "../../config/auth-config";
import { parseWireId, toWireId } from "../../database/object-id";
import { isRole, type Role } from "../memberships/membership";
import type { TenantKind } from "../tenants/tenant";
import {
  ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
} from "./session-policy";

// Application access tokens: compact JWS signed with Ed25519 (RFC 8037),
// typed as access tokens (RFC 9068) and verified strictly per RFC 8725.
// Only this exact shape is accepted; no other algorithm or header can reach
// signature verification.

const ALGORITHM = "EdDSA";
const TOKEN_TYPE = "at+jwt";
const PURPOSE = "access";
const MAX_TOKEN_LENGTH = 2048;
// Tolerated clock difference between instances for the issued-at time.
const CLOCK_SKEW_SECONDS = 30;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export class InvalidAccessTokenError extends Error {
  constructor() {
    super("The access token is not valid.");
    this.name = "InvalidAccessTokenError";
  }
}

// The one tenant a token is for, as the catalog said when it was issued: an
// active membership in a usable tenant. Never the database name; tenant
// routes derive it from the kind and ID.
export interface AccessTokenTenant {
  tenantId: ObjectId;
  role: Role;
  kind: TenantKind;
}

export interface AccessTokenSubject {
  userId: ObjectId;
  sessionId: ObjectId;
  tenant?: AccessTokenTenant;
}

export interface VerifiedAccessToken extends AccessTokenSubject {
  expiresAt: Date;
}

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Rejects non-canonical base64url so one token has exactly one encoding.
function decodeSegment(segment: string): Buffer | undefined {
  if (!SEGMENT.test(segment)) return undefined;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : undefined;
}

function decodeObject(segment: string): Record<string, unknown> | undefined {
  const bytes = decodeSegment(segment);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function signAccessToken(
  auth: AuthConfig,
  subject: AccessTokenSubject,
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
  const header = encodeJson({
    alg: ALGORITHM,
    typ: TOKEN_TYPE,
    kid: auth.signingKey.kid,
  });
  const payload = encodeJson({
    iss: auth.issuer,
    aud: auth.audience,
    sub: toWireId(subject.userId),
    sid: toWireId(subject.sessionId),
    ...(subject.tenant
      ? {
          tid: toWireId(subject.tenant.tenantId),
          role: subject.tenant.role,
          tkind: subject.tenant.kind,
        }
      : {}),
    purpose: PURPOSE,
    iat,
    exp,
  });
  const input = `${header}.${payload}`;
  const signature = sign(
    null,
    Buffer.from(input),
    auth.signingKey.privateKey,
  ).toString("base64url");
  return { token: `${input}.${signature}`, expiresAt: new Date(exp * 1000) };
}

// Checks signature and claims only. Whether the session and account are
// still active is the caller's next step.
export function verifyAccessToken(
  auth: AuthConfig,
  token: unknown,
  now: Date = new Date(),
): VerifiedAccessToken {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH)
    throw new InvalidAccessTokenError();
  const parts = token.split(".");
  if (parts.length !== 3) throw new InvalidAccessTokenError();
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];

  // Exactly alg, typ and kid: crit, jku, x5u and the like are refused.
  const header = decodeObject(headerPart);
  if (
    !header ||
    Object.keys(header).length !== 3 ||
    header.alg !== ALGORITHM ||
    header.typ !== TOKEN_TYPE ||
    typeof header.kid !== "string"
  )
    throw new InvalidAccessTokenError();
  const key = auth.verifyKeys.get(header.kid);
  const signature = decodeSegment(signaturePart);
  if (
    !key ||
    !signature ||
    !verify(null, Buffer.from(`${headerPart}.${payloadPart}`), key, signature)
  )
    throw new InvalidAccessTokenError();

  const claims = decodeObject(payloadPart);
  if (
    !claims ||
    claims.iss !== auth.issuer ||
    claims.aud !== auth.audience ||
    claims.purpose !== PURPOSE
  )
    throw new InvalidAccessTokenError();
  const userId = parseWireId(claims.sub);
  const sessionId = parseWireId(claims.sid);
  const { iat, exp } = claims;
  if (
    !userId ||
    !sessionId ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp)
  )
    throw new InvalidAccessTokenError();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    exp <= nowSeconds ||
    iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    exp - iat > ACCESS_TOKEN_MAX_LIFETIME_SECONDS
  )
    throw new InvalidAccessTokenError();
  const tenant = tenantOf(claims);
  return {
    userId,
    sessionId,
    ...(tenant ? { tenant } : {}),
    expiresAt: new Date(exp * 1000),
  };
}

// All three tenant claims or none. A token with some of them, or with a value
// out of range, was not made by signAccessToken and is refused whole.
function tenantOf(
  claims: Record<string, unknown>,
): AccessTokenTenant | undefined {
  const { tid, role, tkind } = claims;
  if (tid === undefined && role === undefined && tkind === undefined)
    return undefined;
  const tenantId = parseWireId(tid);
  if (
    !tenantId ||
    !isRole(role) ||
    (tkind !== "default" && tkind !== "organization")
  )
    throw new InvalidAccessTokenError();
  return { tenantId, role, kind: tkind };
}
