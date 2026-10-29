import { createHmac, timingSafeEqual } from "node:crypto";

// The token Codex holds for one connector in one chat, in place of the
// member's provider token. The MCP gateway verifies it on every call, then
// checks revocation (chat, membership, connection, connector) before it
// injects the real token. It is useless against any other chat or connector.
//
// It doesn't expire: on the pin, a changed header value restarts the chat's
// Codex process (runtime-adapter/test/codex/gateway-probe.test.ts), so the
// token must stay the same for the chat's life. Revocation is the per-call
// check, not expiry.
//
// Format: `mcp1.<payload>.<signature>`. The payload is base64url JSON and the
// signature is HMAC-SHA256 over `mcp1.<payload>`, with a secret of its own.
// Because the prefix is part of the signed input, a model-gateway token
// (shared/gateway-token.ts: two segments, unprefixed input) never verifies
// here and this token never verifies there, even under one secret.

const PREFIX = "mcp1";
// Valid claims encode to well under this; the cap only stops parse work on
// oversized input.
const MAX_TOKEN_LENGTH = 2048;
const MIN_SECRET_LENGTH = 32;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
// Mongo ObjectIds today; bounded so a claim can't carry a path or a payload.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// The connector slug, as the catalog defines it (platform-next connector.ts).
const SLUG = /^[a-z][a-z0-9_]{1,30}$/;
// Exactly these claims. An unknown one is refused rather than ignored, so a
// gateway older than the platform fails closed on a restriction it doesn't
// understand.
const KEYS = ["t", "u", "c", "s", "r"] as const;

export interface McpCallerClaims {
  readonly tenantId: string;
  readonly userId: string;
  readonly chatId: string;
  // The connector slug; the gateway also checks it against the request path.
  readonly connector: string;
  // The catalog revision the chat's tool policy was taken from.
  readonly revision: number;
}

export function signMcpCallerToken(
  claims: McpCallerClaims,
  secret: string,
): string {
  requireSecret(secret);
  if (!validClaims(claims)) throw new Error("Invalid MCP caller token claims.");
  const payload = Buffer.from(
    JSON.stringify({
      t: claims.tenantId,
      u: claims.userId,
      c: claims.chatId,
      s: claims.connector,
      r: claims.revision,
    }),
  ).toString("base64url");
  return `${PREFIX}.${payload}.${sign(payload, secret)}`;
}

export function verifyMcpCallerToken(
  token: string,
  secret: string,
): McpCallerClaims | null {
  requireSecret(secret);
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const [prefix, payload, signature, extra] = token.split(".");
  if (prefix !== PREFIX || !payload || !signature || extra !== undefined)
    return null;
  if (!SEGMENT.test(payload) || !SEGMENT.test(signature)) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(record).length !== KEYS.length ||
    !KEYS.every((key) => Object.hasOwn(record, key))
  )
    return null;
  const claims = {
    tenantId: record.t,
    userId: record.u,
    chatId: record.c,
    connector: record.s,
    revision: record.r,
  };
  return validClaims(claims) ? claims : null;
}

function validClaims(claims: {
  readonly [K in keyof McpCallerClaims]: unknown;
}): claims is McpCallerClaims {
  return (
    typeof claims.tenantId === "string" &&
    ID.test(claims.tenantId) &&
    typeof claims.userId === "string" &&
    ID.test(claims.userId) &&
    typeof claims.chatId === "string" &&
    ID.test(claims.chatId) &&
    typeof claims.connector === "string" &&
    SLUG.test(claims.connector) &&
    typeof claims.revision === "number" &&
    Number.isSafeInteger(claims.revision) &&
    claims.revision >= 0
  );
}

// A misconfigured secret is a deploy bug, not a bad token: fail loudly.
function requireSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH)
    throw new Error(
      `MCP caller token secret must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${PREFIX}.${payload}`)
    .digest("base64url");
}
