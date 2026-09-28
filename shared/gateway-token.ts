import { createHmac, timingSafeEqual } from "node:crypto";

// Codex only ever holds this token, never the provider key. The gateway checks
// that the token's profile matches the profile in the request path.
//
// Tokens don't expire: Codex keeps a loaded thread's provider config for the
// thread's lifetime, so an expiring token would break long conversations.
// Revoke access by disabling or deleting the profile (checked per request) or
// by rotating MODEL_GATEWAY_SECRET.
export function signGatewayToken(profileId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ p: profileId })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyGatewayToken(
  token: string,
  secret: string,
): { profileId: string } | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  try {
    // Tokens issued before this change also carry `exp`; it is ignored so
    // threads started with them keep working.
    const { p } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof p === "string" && p ? { profileId: p } : null;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
