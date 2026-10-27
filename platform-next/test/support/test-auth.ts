import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { AuthConfig } from "../../src/config/auth-config";
import type { GoogleConfig } from "../../src/config/google-config";

export const TEST_ORIGIN = "http://localhost:3000";

// A throwaway Ed25519 key per call, so no test ever holds a real secret.
export function testAuthConfig(
  overrides: Partial<AuthConfig> = {},
): AuthConfig {
  const { privateKey } = generateKeyPairSync("ed25519");
  const kid = "test-key";
  return {
    issuer: "https://api.truex.test",
    audience: "truex-test",
    signingKey: { kid, privateKey },
    verifyKeys: new Map<string, KeyObject>([
      [kid, createPublicKey(privateKey)],
    ]),
    allowedOrigins: [TEST_ORIGIN],
    cookieSecure: false,
    ...overrides,
  };
}

// Base64 environment values for the same kind of key, for config tests.
export function testKeyEnv(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

export const TEST_GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";

// Endpoints default to unroutable addresses; tests that sign in point them at
// a local fake Google server.
export function testGoogleConfig(
  overrides: Partial<GoogleConfig> = {},
): GoogleConfig {
  return {
    clientId: TEST_GOOGLE_CLIENT_ID,
    clientSecret: "test-client-secret",
    redirectUri: `${TEST_ORIGIN}/api/v1/auth/google/callback`,
    endpoints: {
      authorization: "https://accounts.google.test/o/oauth2/v2/auth",
      token: "http://127.0.0.1:9/token",
      jwks: "http://127.0.0.1:9/certs",
      issuers: ["https://accounts.google.com", "accounts.google.com"],
    },
    ...overrides,
  };
}
