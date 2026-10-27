import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

// Access-token signing and browser-session settings. Key values never appear
// in error messages.

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly signingKey: SigningKey;
  // Every key a token may be signed with: the current signing key plus
  // previous keys kept during a rotation.
  readonly verifyKeys: ReadonlyMap<string, KeyObject>;
  // Browser origins allowed to call cookie-authenticated endpoints.
  readonly allowedOrigins: readonly string[];
  // Secure cookies everywhere except local http development.
  readonly cookieSecure: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PRINTABLE = /^[\x21-\x7e]{1,200}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const GENERATE_HINT = "Run `npm run auth:generate-key` to create one.";

function ed25519Key(
  text: string,
  type: "pkcs8" | "spki",
): KeyObject | undefined {
  if (!BASE64.test(text)) return undefined;
  try {
    const der = { key: Buffer.from(text, "base64"), format: "der" as const };
    const key =
      type === "pkcs8"
        ? createPrivateKey({ ...der, type })
        : createPublicKey({ ...der, type });
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

// Accepts only an exact origin ("https://app.example.com", no path or slash):
// https, or plain http on a loopback host for local development.
export function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== value) return undefined;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
      return url;
  } catch {
    // Not a URL.
  }
  return undefined;
}

export function requiredText(
  env: Env,
  name: string,
  problems: string[],
): string | undefined {
  const value = env[name] ?? "";
  if (!value) problems.push(`${name} is required.`);
  else if (!PRINTABLE.test(value))
    problems.push(`${name} must be 1-200 printable characters without spaces.`);
  else return value;
  return undefined;
}

export function loadAuthConfig(
  env: Env,
  problems: string[],
): AuthConfig | undefined {
  const before = problems.length;
  const issuer = requiredText(env, "AUTH_ISSUER", problems);
  const audience = requiredText(env, "AUTH_AUDIENCE", problems);

  const kid = env.AUTH_SIGNING_KEY_ID ?? "";
  if (!kid) problems.push("AUTH_SIGNING_KEY_ID is required.");
  else if (!KEY_ID.test(kid))
    problems.push(
      "AUTH_SIGNING_KEY_ID must be 1-64 letters, digits or . _ - characters.",
    );

  const keyText = env.AUTH_SIGNING_KEY ?? "";
  const privateKey = keyText ? ed25519Key(keyText, "pkcs8") : undefined;
  if (!keyText) problems.push(`AUTH_SIGNING_KEY is required. ${GENERATE_HINT}`);
  else if (!privateKey)
    problems.push(
      `AUTH_SIGNING_KEY must be a base64 PKCS#8 DER Ed25519 private key. ${GENERATE_HINT}`,
    );

  const verifyKeys = new Map<string, KeyObject>();
  if (privateKey && KEY_ID.test(kid))
    verifyKeys.set(kid, createPublicKey(privateKey));
  const previous = (env.AUTH_VERIFY_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of previous) {
    // Key IDs cannot contain "=", so the first one separates ID from key.
    const split = entry.indexOf("=");
    const id = entry.slice(0, split);
    const publicKey =
      split > 0 ? ed25519Key(entry.slice(split + 1), "spki") : undefined;
    if (!KEY_ID.test(id) || !publicKey) {
      problems.push(
        "AUTH_VERIFY_KEYS must be a comma-separated list of <key id>=<base64 SPKI DER Ed25519 public key>.",
      );
      break;
    }
    if (verifyKeys.has(id) || id === kid) {
      problems.push(
        `AUTH_VERIFY_KEYS repeats key ID "${id}" or reuses the signing key ID.`,
      );
      break;
    }
    verifyKeys.set(id, publicKey);
  }

  const originList = (env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const origins = originList.map(parseOrigin);
  if (originList.length === 0)
    problems.push("AUTH_ALLOWED_ORIGINS is required.");
  else if (origins.some((origin) => !origin))
    problems.push(
      "AUTH_ALLOWED_ORIGINS must be exact origins such as https://app.example.com (http only for localhost).",
    );
  const secure = origins.map((origin) => origin?.protocol === "https:");
  const cookieSecure = secure.every(Boolean);
  if (!cookieSecure && secure.some(Boolean))
    problems.push(
      "AUTH_ALLOWED_ORIGINS must all use https, or all be local http for development.",
    );

  if (problems.length > before || !issuer || !audience || !privateKey)
    return undefined;
  return {
    issuer,
    audience,
    signingKey: { kid, privateKey },
    verifyKeys,
    allowedOrigins: originList,
    cookieSecure,
  };
}
