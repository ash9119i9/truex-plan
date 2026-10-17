import { createHmac } from "node:crypto";

// The token Codex sends to the model gateway for one model profile. Same
// format as shared/gateway-token.ts, which the gateway verifies; this package
// builds only from its own sources, so the signer is repeated here and a test
// pins it to a token produced by the shared implementation.
//
// It grants access to that one profile only and holds no provider key. It
// does not expire (Codex keeps a thread's provider config for the thread's
// life); disabling the model or rotating the secret revokes it. `t` labels
// the tenant for the gateway's usage logs and grants nothing.
export function signGatewayToken(
  modelId: string,
  secret: string,
  tenantId: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ p: modelId, t: tenantId }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
