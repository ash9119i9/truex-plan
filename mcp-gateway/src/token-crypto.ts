import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";
import { Binary } from "mongodb";

// The sealed form of a member's provider tokens on an `mcp_connections` row.
// It is byte-for-byte platform-next's format (connectors/token-crypto.ts):
// both services read and write the same rows until platform-next hands
// sealing to the gateway (tasks/mcp-gateway-todo.md, Task 34). Fixed vectors
// in both packages' tests pin the compatibility.
//
// AES-256-GCM. The additional authenticated data binds a ciphertext to one
// tenant, owner, connector and key, so a row copied elsewhere fails to open
// even under the same key. Any configured key opens; the active key seals.
// Values never appear in logs or errors.

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ConnectorTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface SealedSecret {
  keyId: string;
  iv: Binary;
  tag: Binary;
  ciphertext: Binary;
}

// Hex ObjectId strings. Order and separator are fixed by the format.
export interface SecretAad {
  tenantId: string;
  ownerId: string;
  connectorId: string;
}

export interface TokenKeys {
  // The active key plus previous keys kept during a rotation.
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string;
}

// Unknown key, bad tag or IV, or an AAD that doesn't match. Never says which.
export class TokenDecryptError extends Error {
  constructor() {
    super("The stored connector token could not be decrypted.");
    this.name = "TokenDecryptError";
  }
}

function aadBytes(aad: SecretAad, keyId: string): Buffer {
  return Buffer.from(
    `${aad.tenantId}|${aad.ownerId}|${aad.connectorId}|${keyId}`,
    "utf8",
  );
}

export function sealTokens(
  keys: TokenKeys,
  aad: SecretAad,
  tokens: ConnectorTokens,
): SealedSecret {
  const keyId = keys.activeKeyId;
  const key = keys.keys.get(keyId);
  if (!key) throw new Error("The active connector token key is missing.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aadBytes(aad, keyId));
  const plaintext = Buffer.from(
    JSON.stringify({
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    }),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    keyId,
    iv: new Binary(iv),
    tag: new Binary(cipher.getAuthTag()),
    ciphertext: new Binary(ciphertext),
  };
}

export function openTokens(
  keys: TokenKeys,
  aad: SecretAad,
  sealed: SealedSecret,
): ConnectorTokens {
  const key = keys.keys.get(sealed.keyId);
  if (!key) throw new TokenDecryptError();
  const iv = sealed.iv.buffer;
  const tag = sealed.tag.buffer;
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new TokenDecryptError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aadBytes(aad, sealed.keyId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(sealed.ciphertext.buffer),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { accessToken?: unknown }).accessToken !== "string"
    )
      throw new TokenDecryptError();
    const { accessToken, refreshToken } = parsed as ConnectorTokens;
    return {
      accessToken,
      ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    };
  } catch (error) {
    if (error instanceof TokenDecryptError) throw error;
    // A tag mismatch surfaces from final(); never pass its text on.
    throw new TokenDecryptError();
  }
}
