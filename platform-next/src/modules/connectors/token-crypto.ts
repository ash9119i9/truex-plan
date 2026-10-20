import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";
import { Binary } from "mongodb";
import type { ConnectorsConfig } from "../../config/connectors-config";

// Encrypts the OAuth tokens a user grants a connector with AES-256-GCM. The
// additional authenticated data binds a ciphertext to one tenant, owner,
// connector and key, so a row copied to another owner, connector or tenant
// fails to decrypt even though the key is the same. Rotation is supported: any
// configured key decrypts, the active key encrypts. Values never appear in
// logs or errors.

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// The decrypted token pair. refreshToken is stored when the provider returns
// one; v1 does no refresh, it only carries it.
export interface ConnectorTokens {
  accessToken: string;
  refreshToken?: string;
}

// The sealed form stored on a connection document. Binary so MongoDB keeps the
// bytes exactly.
export interface SealedSecret {
  keyId: string;
  iv: Binary;
  tag: Binary;
  ciphertext: Binary;
}

// Names the row a ciphertext belongs to. All four fields are hex ObjectId
// strings except keyId; order and separator are fixed.
export interface SecretAad {
  tenantId: string;
  ownerId: string;
  connectorId: string;
}

// Decryption failed: the key is unknown, the tag does not verify, or the AAD
// does not match (a row moved to another owner). Never says which.
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

// Seals the tokens with the active key, binding them to this row.
export function sealTokens(
  config: ConnectorsConfig,
  aad: SecretAad,
  tokens: ConnectorTokens,
): SealedSecret {
  const keyId = config.activeKeyId;
  const key = config.keys.get(keyId);
  // The config guarantees the active key is present; this is a safety net.
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
  const tag = cipher.getAuthTag();
  return {
    keyId,
    iv: new Binary(iv),
    tag: new Binary(tag),
    ciphertext: new Binary(ciphertext),
  };
}

// Opens a sealed secret. Uses the key the ciphertext names (rotation: an old
// key still decrypts). A wrong AAD, tag or unknown key all raise the same
// TokenDecryptError.
export function openTokens(
  config: ConnectorsConfig,
  aad: SecretAad,
  sealed: SealedSecret,
): ConnectorTokens {
  const key = config.keys.get(sealed.keyId);
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
    // An auth-tag mismatch surfaces as an error from final(); never leak it.
    throw new TokenDecryptError();
  }
}
