import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";
import { readSingleCookie } from "../../common/http/cookies";
import type { ConnectorsConfig } from "../../config/connectors-config";

// One connector sign-in attempt, sealed in a short-lived cookie rather than
// the database: starting a connect writes nothing server-side, and the attempt
// is bound to the browser that started it. Unlike the Google sign-in cookie
// this one IS encrypted (AES-256-GCM with the active connector token key, AAD
// "connector-oauth-flow"), because it carries the PKCE verifier and the tenant
// and user the callback must re-check. It is path-scoped to the callback route
// and cleared on use.

// Not __Host-: that prefix requires Path=/, and this cookie is scoped to the
// callback route so it never rides along on other requests.
const SECURE_NAME = "__Secure-truex_connector_oauth";
const LOCAL_NAME = "truex_connector_oauth";
export const CONNECTOR_FLOW_TTL_SECONDS = 10 * 60;
const AAD = Buffer.from("connector-oauth-flow", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_COOKIE_BYTES = 4096;

export interface ConnectorFlow {
  state: string;
  codeVerifier: string;
  // Hex ObjectId of the catalog connector, and its revision at connect time.
  connectorId: string;
  connectorRevision: number;
  // The connector slug, so an error redirect can name it (?connector=<slug>)
  // without a catalog read.
  slug: string;
  // Hex ObjectIds of the tenant and user the callback must re-check.
  tenantId: string;
  userId: string;
  // The tenant database the guard resolved at connect time. The callback runs
  // on the cookie alone (no tenant guard), so it cannot re-derive the default
  // tenant's database from the ID; carrying it keeps the write and the AAD
  // consistent with the tenant-guarded routes.
  dbName: string;
  // Unix seconds.
  startedAt: number;
}

function cookieName(secure: boolean): string {
  return secure ? SECURE_NAME : LOCAL_NAME;
}

function activeKey(config: ConnectorsConfig): Buffer {
  const key = config.keys.get(config.activeKeyId);
  if (!key) throw new Error("The active connector token key is missing.");
  return key;
}

// Seals the flow into an opaque cookie value: base64url(iv | tag | ciphertext).
export function sealConnectorFlow(
  config: ConnectorsConfig,
  flow: ConnectorFlow,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", activeKey(config), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(flow), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

// Opens a sealed flow cookie, or undefined when it is absent, malformed, or
// does not decrypt (tampered, or sealed with a key this process does not
// have). Every configured key is tried, so a rotation does not strand a flow
// that is already in progress.
export function openConnectorFlow(
  config: ConnectorsConfig,
  value: string | undefined,
): ConnectorFlow | undefined {
  if (!value || value.length > MAX_COOKIE_BYTES) return undefined;
  let raw: Buffer;
  try {
    raw = Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
  if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  for (const key of config.keys.values()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      const parsed = parseFlow(plaintext.toString("utf8"));
      if (parsed) return parsed;
    } catch {
      // Wrong key or tampered: try the next key.
    }
  }
  return undefined;
}

function parseFlow(text: string): ConnectorFlow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const flow = value as Record<string, unknown>;
  if (
    typeof flow.state !== "string" ||
    typeof flow.codeVerifier !== "string" ||
    typeof flow.connectorId !== "string" ||
    typeof flow.connectorRevision !== "number" ||
    typeof flow.slug !== "string" ||
    typeof flow.tenantId !== "string" ||
    typeof flow.userId !== "string" ||
    typeof flow.dbName !== "string" ||
    typeof flow.startedAt !== "number"
  )
    return undefined;
  return {
    state: flow.state,
    codeVerifier: flow.codeVerifier,
    connectorId: flow.connectorId,
    connectorRevision: flow.connectorRevision,
    slug: flow.slug,
    tenantId: flow.tenantId,
    userId: flow.userId,
    dbName: flow.dbName,
    startedAt: flow.startedAt,
  };
}

// Sets the sealed cookie, scoped to the callback path so it is sent on the
// callback only. SameSite=Lax: the provider returns the browser with a
// cross-site top-level GET, which Strict cookies would not accompany.
export function setConnectorFlowCookie(
  res: Response,
  secure: boolean,
  callbackPath: string,
  sealed: string,
): void {
  res.append(
    "Set-Cookie",
    [
      `${cookieName(secure)}=${sealed}`,
      `Path=${callbackPath}`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${CONNECTOR_FLOW_TTL_SECONDS}`,
      ...(secure ? ["Secure"] : []),
    ].join("; "),
  );
}

export function clearConnectorFlowCookie(
  res: Response,
  secure: boolean,
  callbackPath: string,
): void {
  res.append(
    "Set-Cookie",
    [
      `${cookieName(secure)}=`,
      `Path=${callbackPath}`,
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      ...(secure ? ["Secure"] : []),
    ].join("; "),
  );
}

// Reads and opens the flow cookie from a callback request.
export function readConnectorFlow(
  req: Request,
  config: ConnectorsConfig,
  secure: boolean,
): ConnectorFlow | undefined {
  const value = readSingleCookie(req, cookieName(secure));
  return openConnectorFlow(config, value);
}

// Constant-time state comparison, after a format check that also guarantees
// equal byte lengths (timingSafeEqual requires them).
const STATE = /^[A-Za-z0-9_-]{43}$/;

export function stateMatches(expected: string, returned: unknown): boolean {
  if (
    typeof returned !== "string" ||
    !STATE.test(returned) ||
    !STATE.test(expected)
  )
    return false;
  return timingSafeEqual(Buffer.from(returned), Buffer.from(expected));
}

// A 43-character base64url secret (256 bits), used for both the state and the
// PKCE code verifier.
export function flowSecret(): string {
  return randomBytes(32).toString("base64url");
}

// PKCE S256 (RFC 7636): base64url(SHA-256(code verifier)).
export function codeChallengeOf(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}
