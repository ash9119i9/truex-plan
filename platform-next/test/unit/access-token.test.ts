import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { ObjectId } from "mongodb";
import {
  InvalidAccessTokenError,
  signAccessToken,
  verifyAccessToken,
} from "../../src/modules/sessions/access-token";
import { ACCESS_TOKEN_TTL_SECONDS } from "../../src/modules/sessions/session-policy";
import { testAuthConfig } from "../support/test-auth";

const auth = testAuthConfig();
const NOW = new Date("2026-10-15T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const subject = { userId: new ObjectId(), sessionId: new ObjectId() };

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function validClaims(): Record<string, unknown> {
  return {
    iss: auth.issuer,
    aud: auth.audience,
    sub: subject.userId.toHexString(),
    sid: subject.sessionId.toHexString(),
    purpose: "access",
    iat: NOW_S,
    exp: NOW_S + ACCESS_TOKEN_TTL_SECONDS,
  };
}

// Signs any header/payload with the test key, to build tokens that carry a
// valid signature but break one rule.
function forge(
  header: object,
  payload: object,
  key = auth.signingKey.privateKey,
): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

const HEADER = { alg: "EdDSA", typ: "at+jwt", kid: auth.signingKey.kid };

function rejects(token: unknown, at = NOW): void {
  assert.throws(
    () => verifyAccessToken(auth, token, at),
    InvalidAccessTokenError,
  );
}

describe("access tokens", () => {
  test("a signed token verifies to its subject and expiry", () => {
    const { token, expiresAt } = signAccessToken(auth, subject, NOW);
    const verified = verifyAccessToken(auth, token, NOW);
    assert.ok(verified.userId.equals(subject.userId));
    assert.ok(verified.sessionId.equals(subject.sessionId));
    assert.equal(verified.expiresAt.getTime(), expiresAt.getTime());
    assert.equal(
      expiresAt.getTime() - NOW.getTime(),
      ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
  });

  test("a forged token with valid claims and the right shape verifies", () => {
    // Guards the helper: the rejections below fail for their one reason only.
    verifyAccessToken(auth, forge(HEADER, validClaims()), NOW);
  });

  test("expires exactly at exp", () => {
    const { token } = signAccessToken(auth, subject, NOW);
    const exp = NOW.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000;
    verifyAccessToken(auth, token, new Date(exp - 1000));
    rejects(token, new Date(exp));
  });

  test("rejects non-strings, oversized and malformed tokens", () => {
    for (const token of [
      undefined,
      null,
      42,
      {},
      "",
      "a.b",
      "a.b.c.d",
      "x".repeat(3000),
    ])
      rejects(token);
  });

  test("rejects other algorithms and extra header fields", () => {
    for (const header of [
      { ...HEADER, alg: "none" },
      { ...HEADER, alg: "HS256" },
      { ...HEADER, alg: "RS256" },
      { ...HEADER, typ: "JWT" },
      { alg: "EdDSA", typ: "at+jwt" },
      { ...HEADER, kid: 1 },
      { ...HEADER, crit: ["exp"] },
      { ...HEADER, jku: "https://evil.test/keys" },
    ])
      rejects(forge(header, validClaims()));
  });

  test("rejects an unsigned token", () => {
    const [h, p] = forge({ ...HEADER, alg: "none" }, validClaims()).split(".");
    rejects(`${h}.${p}.`);
  });

  test("rejects an unknown key ID and a key the config does not trust", () => {
    rejects(forge({ ...HEADER, kid: "other" }, validClaims()));
    const { privateKey } = generateKeyPairSync("ed25519");
    rejects(forge(HEADER, validClaims(), privateKey));
  });

  test("rejects a tampered payload", () => {
    const [h, , s] = signAccessToken(auth, subject, NOW).token.split(".");
    const other = b64({ ...validClaims(), sub: new ObjectId().toHexString() });
    rejects(`${h}.${other}.${s}`);
  });

  test("rejects a non-canonical base64url encoding", () => {
    const { token } = signAccessToken(auth, subject, NOW);
    const [h, p, s] = token.split(".") as [string, string, string];
    rejects(`${h}=.${p}.${s}`);
    rejects(`${h}.${p}.${s}=`);
  });

  test("rejects wrong issuer, audience or purpose", () => {
    for (const change of [
      { iss: "https://other.test" },
      { aud: "other-app" },
      { aud: [auth.audience] },
      { purpose: "refresh" },
      { purpose: undefined },
    ])
      rejects(forge(HEADER, { ...validClaims(), ...change }));
  });

  test("rejects bad subject, session or time claims", () => {
    for (const change of [
      { sub: "not-an-id" },
      { sub: subject.userId.toHexString().toUpperCase() },
      { sid: undefined },
      { iat: "1" },
      { exp: NOW_S + 0.5 },
      // Issued in the future beyond clock skew.
      { iat: NOW_S + 60, exp: NOW_S + 120 },
      // Longer-lived than any token this app issues.
      { exp: NOW_S + ACCESS_TOKEN_TTL_SECONDS + 1 },
    ])
      rejects(forge(HEADER, { ...validClaims(), ...change }));
  });

  test("tolerates small clock skew on iat", () => {
    verifyAccessToken(
      auth,
      forge(HEADER, { ...validClaims(), iat: NOW_S + 20, exp: NOW_S + 200 }),
      NOW,
    );
  });

  test("a rotated-away key verifies only while it is listed", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const old = testAuthConfig({ signingKey: { kid: "old-key", privateKey } });
    const { token } = signAccessToken(old, subject, NOW);
    rejects(token);
    const rotated = testAuthConfig({
      signingKey: auth.signingKey,
      verifyKeys: new Map([
        ...auth.verifyKeys,
        ["old-key", createPublicKey(privateKey)],
      ]),
    });
    verifyAccessToken(rotated, token, NOW);
  });
});
