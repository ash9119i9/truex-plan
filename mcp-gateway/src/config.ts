import type { ClientSecretRef } from "./refresh-grant";
import type { TokenKeys } from "./token-crypto";

// Configuration the refresh path needs, read the way platform-next reads it
// (config/connectors-config.ts, connectors/client-secret.resolver.ts), so one
// set of values configures both services during the overlap.

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_BYTES = 32;
// Matches platform-next and model-gateway.
const SECRET_TTL_MS = 5 * 60_000;

type Env = Readonly<Record<string, string | undefined>>;

// CONNECTORS_ALLOW_LOOPBACK=1 lets the gateway reach loopback http servers
// (egress.ts), for fixture servers in local dev only: it is refused with
// NODE_ENV=production or when the gateway listens beyond loopback, which a
// deployed gateway always does.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadEgressConfig(
  env: Env,
  problems: string[],
): { allowLoopback: boolean } {
  if (env.CONNECTORS_ALLOW_LOOPBACK !== "1") return { allowLoopback: false };
  if (
    env.NODE_ENV === "production" ||
    !LOCAL_HOSTS.has(env.HOST || "127.0.0.1")
  ) {
    problems.push(
      "CONNECTORS_ALLOW_LOOPBACK is for local development only: it can't be set with NODE_ENV=production or a HOST other than a loopback address.",
    );
    return { allowLoopback: false };
  }
  return { allowLoopback: true };
}

// MCP_TOKEN_KEYS ("<id>=<base64 32-byte key>,...") and MCP_TOKEN_ACTIVE_KEY.
// Key values are never echoed in a problem.
export function loadTokenKeys(
  env: Env,
  problems: string[],
): TokenKeys | undefined {
  const keys = new Map<string, Buffer>();
  const text = env.MCP_TOKEN_KEYS ?? "";
  const activeKeyId = env.MCP_TOKEN_ACTIVE_KEY ?? "";
  const before = problems.length;
  if (!text) problems.push("MCP_TOKEN_KEYS is required.");
  for (const entry of text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const split = entry.indexOf("=");
    const id = entry.slice(0, split);
    const value = split > 0 ? entry.slice(split + 1) : "";
    const key = BASE64.test(value) ? Buffer.from(value, "base64") : undefined;
    if (!KEY_ID.test(id) || key?.length !== KEY_BYTES || keys.has(id)) {
      problems.push(
        "MCP_TOKEN_KEYS must be a comma-separated list of unique <key id>=<base64 32-byte key>.",
      );
      break;
    }
    keys.set(id, key);
  }
  if (!activeKeyId) problems.push("MCP_TOKEN_ACTIVE_KEY is required.");
  else if (problems.length === before && !keys.has(activeKeyId))
    problems.push("MCP_TOKEN_ACTIVE_KEY must name one of MCP_TOKEN_KEYS.");
  return problems.length === before ? { keys, activeKeyId } : undefined;
}

// A Secrets Manager ARN in production, or a process.env name for local
// development. The AWS SDK is loaded only when an ARN is first needed.
// Errors carry no secret, ARN or AWS text.
export function createSecretResolver(
  env: Env = process.env,
): (ref: ClientSecretRef) => Promise<string> {
  const cache = new Map<string, { value: string; expires: number }>();
  let client: import("@aws-sdk/client-secrets-manager").SecretsManagerClient;
  return async (ref) => {
    if ("env" in ref) {
      const value = env[ref.env];
      if (!value) throw new Error("The connector client secret is not set.");
      return value;
    }
    const hit = cache.get(ref.arn);
    if (hit && hit.expires > Date.now()) return hit.value;
    const sdk = await import("@aws-sdk/client-secrets-manager");
    client ??= new sdk.SecretsManagerClient({});
    let value: string | undefined;
    try {
      value = (
        await client.send(new sdk.GetSecretValueCommand({ SecretId: ref.arn }))
      ).SecretString;
    } catch {
      value = undefined;
    }
    if (!value)
      throw new Error("The connector client secret could not be resolved.");
    cache.set(ref.arn, { value, expires: Date.now() + SECRET_TTL_MS });
    return value;
  };
}
