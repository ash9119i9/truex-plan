import { createDecipheriv } from "node:crypto";
import { ApiError } from "./errors";

// Read compatibility for existing AES-256-GCM MCP credentials. New saves use
// plain apiKey and do not need these environment settings.
export interface EncryptedSecret {
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  data: string;
}

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const kidPattern = /^[\w.-]{1,32}$/;

function misconfigured(message: string): never {
  throw new ApiError(503, message, "MCP_ENCRYPTION_NOT_CONFIGURED");
}
function decodeKey(kid: string, value: string): Buffer {
  if (!kidPattern.test(kid))
    misconfigured(
      "MCP encryption key ids must be 1–32 letters, digits, dots, underscores or hyphens",
    );
  const text = value.trim();
  const key = base64.test(text) ? Buffer.from(text, "base64") : undefined;
  if (key?.length !== 32)
    misconfigured(
      `MCP encryption key ${kid} must be base64 that decodes to exactly 32 bytes`,
    );
  return key;
}

// Read on every call, so a rotated env takes effect on restart and tests can
// change it without reloading the module.
function keyring() {
  const keys = new Map<string, Buffer>();
  for (const entry of (process.env.MCP_ENCRYPTION_KEYS || "").split(",")) {
    if (!entry.trim()) continue;
    const at = entry.indexOf(":");
    if (at < 1)
      misconfigured("MCP_ENCRYPTION_KEYS entries must look like kid:base64");
    const kid = entry.slice(0, at).trim();
    keys.set(kid, decodeKey(kid, entry.slice(at + 1)));
  }
  const kid = process.env.MCP_ENCRYPTION_KID?.trim() || "k1";
  const value = process.env.MCP_ENCRYPTION_KEY?.trim();
  if (!value) return keys;
  const key = decodeKey(kid, value);
  if (keys.has(kid) && !keys.get(kid)!.equals(key))
    misconfigured(
      `MCP_ENCRYPTION_KEYS lists ${kid} with a different key than MCP_ENCRYPTION_KEY`,
    );
  keys.set(kid, key);
  return keys;
}

// The key id is bound into the tag, so a record cannot be relabelled.
const aad = (kid: string) => Buffer.from(`truex-mcp:v1:${kid}`);

export function decryptSecret(value: unknown): string {
  const record = value as Partial<EncryptedSecret> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.v !== 1 ||
    [record.kid, record.iv, record.tag, record.data].some(
      (field) => typeof field !== "string",
    )
  )
    throw new ApiError(
      422,
      "Stored MCP API key has an unknown format",
      "MCP_DECRYPTION_FAILED",
    );
  const key = keyring().get(record.kid!);
  if (!key)
    misconfigured(
      `MCP API key uses encryption key ${record.kid}, which is not configured`,
    );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv!, "base64"),
    );
    decipher.setAAD(aad(record.kid!));
    decipher.setAuthTag(Buffer.from(record.tag!, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.data!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new ApiError(
      422,
      "Stored MCP API key could not be decrypted. Enter the key again.",
      "MCP_DECRYPTION_FAILED",
      { cause: error },
    );
  }
}
