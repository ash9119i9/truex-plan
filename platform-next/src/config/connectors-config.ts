import { parseOrigin } from "./auth-config";

// Directory-connector settings. Tokens users grant a connector are encrypted
// with these AES-256-GCM keys; the same keys seal the short-lived OAuth flow
// cookie. Key values never appear in error messages. All of this is optional:
// when no keys are set the connectors feature is off and its routes answer a
// clear 503, so the rest of the app still starts.

export interface ConnectorsTokenKey {
  readonly keyId: string;
  // Exactly 32 bytes: an AES-256 key.
  readonly key: Buffer;
}

export interface ConnectorsConfig {
  // Every key a stored token may be sealed with: the active key plus previous
  // keys kept during a rotation, so old rows still decrypt.
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string;
  // Where the provider sends the browser back; its origin is an allowed
  // origin, like GOOGLE_REDIRECT_URI.
  readonly redirectUri: string;
  // Loopback http endpoints are accepted in discovery only when this is set,
  // for the fixture authorization and MCP servers in tests and local dev.
  readonly allowLoopback: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_BYTES = 32;
const GENERATE_HINT = "Run `npm run connectors:generate-key` to create one.";

// A base64 string that decodes to exactly 32 bytes, or undefined. The value
// is a secret, so a bad one is reported without being echoed.
function key32(text: string): Buffer | undefined {
  if (!BASE64.test(text)) return undefined;
  try {
    const buffer = Buffer.from(text, "base64");
    return buffer.length === KEY_BYTES ? buffer : undefined;
  } catch {
    return undefined;
  }
}

// Reads the connector token keys. Returns undefined (feature off) only when
// BOTH MCP_TOKEN_KEYS and MCP_TOKEN_ACTIVE_KEY are absent; setting one without
// the other, or a malformed value, is a configuration problem rather than a
// silent disable.
export function loadConnectorsConfig(
  env: Env,
  // Undefined when the auth settings are themselves invalid, so the origin
  // check does not add a second, misleading problem.
  allowedOrigins: readonly string[] | undefined,
  problems: string[],
): ConnectorsConfig | undefined {
  const keysText = env.MCP_TOKEN_KEYS ?? "";
  const activeKeyId = env.MCP_TOKEN_ACTIVE_KEY ?? "";
  if (!keysText && !activeKeyId) return undefined;
  const before = problems.length;

  const keys = new Map<string, Buffer>();
  if (!keysText) problems.push(`MCP_TOKEN_KEYS is required. ${GENERATE_HINT}`);
  else
    for (const entry of keysText
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      // Key IDs cannot contain "=", so the first one separates ID from key.
      const split = entry.indexOf("=");
      const id = entry.slice(0, split);
      const key = split > 0 ? key32(entry.slice(split + 1)) : undefined;
      if (!KEY_ID.test(id) || !key) {
        problems.push(
          "MCP_TOKEN_KEYS must be a comma-separated list of <key id>=<base64 32-byte key>.",
        );
        break;
      }
      if (keys.has(id)) {
        problems.push(`MCP_TOKEN_KEYS repeats key ID "${id}".`);
        break;
      }
      keys.set(id, key);
    }

  if (!activeKeyId) problems.push("MCP_TOKEN_ACTIVE_KEY is required.");
  else if (!KEY_ID.test(activeKeyId))
    problems.push(
      "MCP_TOKEN_ACTIVE_KEY must be 1-64 letters, digits or . _ - characters.",
    );
  else if (keysText && !keys.has(activeKeyId) && problems.length === before)
    problems.push("MCP_TOKEN_ACTIVE_KEY must name one of MCP_TOKEN_KEYS.");

  const redirectUri = env.CONNECTORS_REDIRECT_URI ?? "";
  if (!redirectUri) problems.push("CONNECTORS_REDIRECT_URI is required.");
  else {
    let url: URL | undefined;
    try {
      url = new URL(redirectUri);
    } catch {
      // Reported below.
    }
    if (
      !url ||
      url.href !== redirectUri ||
      url.search ||
      url.hash ||
      !parseOrigin(url.origin)
    )
      problems.push(
        "CONNECTORS_REDIRECT_URI must be an absolute https URL (http only for localhost) without query or fragment.",
      );
    else if (allowedOrigins && !allowedOrigins.includes(url.origin))
      problems.push(
        "CONNECTORS_REDIRECT_URI must be on one of the AUTH_ALLOWED_ORIGINS.",
      );
  }

  if (problems.length > before) return undefined;
  return {
    keys,
    activeKeyId,
    redirectUri,
    allowLoopback: env.CONNECTORS_ALLOW_LOOPBACK === "1",
  };
}
