import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { Binary } from "mongodb";
import {
  openTokens,
  sealTokens,
  TokenDecryptError,
  type SealedSecret,
  type SecretAad,
  type TokenKeys,
} from "../src/token-crypto";

// The gateway must open what platform-next stored, and the reverse
// (platform-next/test/unit/connectors-crypto.test.ts holds a gateway vector).
// These vectors came from platform-next's sealTokens, with fixed keys k0 (old,
// rotated out of "active") and k1 (active).
const KEYS: TokenKeys = {
  keys: new Map([
    ["k0", Buffer.alloc(32, 3)],
    ["k1", Buffer.alloc(32, 7)],
  ]),
  activeKeyId: "k1",
};
const AAD: SecretAad = {
  tenantId: "64f0c2a9e1b2c3d4e5f60700",
  ownerId: "64f0c2a9e1b2c3d4e5f60718",
  connectorId: "64f0c2a9e1b2c3d4e5f60719",
};
const TOKENS = {
  accessToken: "gho_platform_vector_access",
  refreshToken: "ghr_platform_vector_refresh",
};

function sealed(v: {
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}): SealedSecret {
  const bin = (b64: string) => new Binary(Buffer.from(b64, "base64"));
  return {
    keyId: v.keyId,
    iv: bin(v.iv),
    tag: bin(v.tag),
    ciphertext: bin(v.ciphertext),
  };
}

const PLATFORM_K1 = sealed({
  keyId: "k1",
  iv: "ijuVjEdLzVMnBJDT",
  tag: "NwE+3Ew0RPkr4Qr7vGN/IQ==",
  ciphertext:
    "GnYR8qwtJFXUX2tYJ1M4WQiAPigMClK66hLFA99FBUKqJ0Y7mTPjPDYSPakIfFe6qFVh6d88b6B1nPuy5KoMdxENPvIuWX+JIzT1c9q9tcXd2PaXO+Qc1v0=",
});
const PLATFORM_K0 = sealed({
  keyId: "k0",
  iv: "sr4aWHsqGmo5riRO",
  tag: "5Z07nBIIIolF303gYnQ2Dg==",
  ciphertext:
    "gSJ9XQ0OaXmSVJ+nMXMxTpodUMmdYuSAf2YkQi9kU+STHNQmOuH2zBdUG5btCDgO3ck/30oRZdFkS0Wbk1RL2mOSEEzAGc5/4Pd8eiGULfdUoNAggMtjp+E=",
});

describe("token-crypto (platform-next compatible)", () => {
  test("opens tokens platform-next sealed, with the active and a rotated key", () => {
    assert.deepEqual(openTokens(KEYS, AAD, PLATFORM_K1), TOKENS);
    assert.deepEqual(openTokens(KEYS, AAD, PLATFORM_K0), TOKENS);
  });

  test("seals with the active key and opens its own, with or without a refresh token", () => {
    const both = sealTokens(KEYS, AAD, TOKENS);
    assert.equal(both.keyId, "k1");
    assert.equal(both.iv.buffer.length, 12);
    assert.equal(both.tag.buffer.length, 16);
    assert.deepEqual(openTokens(KEYS, AAD, both), TOKENS);
    const accessOnly = sealTokens(KEYS, AAD, { accessToken: "at-only" });
    assert.deepEqual(openTokens(KEYS, AAD, accessOnly), {
      accessToken: "at-only",
    });
    const again = sealTokens(KEYS, AAD, TOKENS);
    assert.notDeepEqual(
      again.iv.buffer,
      both.iv.buffer,
      "a fresh IV each time",
    );
  });

  test("a row moved to another owner, connector or tenant can't be opened", () => {
    for (const moved of [
      { ...AAD, ownerId: "64f0c2a9e1b2c3d4e5f60799" },
      { ...AAD, connectorId: "64f0c2a9e1b2c3d4e5f60799" },
      { ...AAD, tenantId: "64f0c2a9e1b2c3d4e5f60799" },
    ])
      assert.throws(
        () => openTokens(KEYS, moved, PLATFORM_K1),
        TokenDecryptError,
      );
  });

  test("an unknown key, a relabelled key, a bad tag or a bad IV can't be opened", () => {
    const onlyK1: TokenKeys = {
      keys: new Map([["k1", Buffer.alloc(32, 7)]]),
      activeKeyId: "k1",
    };
    assert.throws(
      () => openTokens(onlyK1, AAD, PLATFORM_K0),
      TokenDecryptError,
    );
    const wrongKey: TokenKeys = {
      keys: new Map([["k1", randomBytes(32)]]),
      activeKeyId: "k1",
    };
    assert.throws(
      () => openTokens(wrongKey, AAD, PLATFORM_K1),
      TokenDecryptError,
    );
    // The key ID is part of the AAD, so relabelling a ciphertext fails too.
    const relabelled: TokenKeys = {
      keys: new Map([["k9", Buffer.alloc(32, 7)]]),
      activeKeyId: "k9",
    };
    assert.throws(
      () => openTokens(relabelled, AAD, { ...PLATFORM_K1, keyId: "k9" }),
      TokenDecryptError,
    );
    const tag = Buffer.from(PLATFORM_K1.tag.buffer);
    tag[0] = tag[0]! ^ 1;
    assert.throws(
      () => openTokens(KEYS, AAD, { ...PLATFORM_K1, tag: new Binary(tag) }),
      TokenDecryptError,
    );
    assert.throws(
      () =>
        openTokens(KEYS, AAD, {
          ...PLATFORM_K1,
          iv: new Binary(Buffer.alloc(8)),
        }),
      TokenDecryptError,
    );
  });

  test("the error never carries the token or the key", () => {
    try {
      openTokens(
        KEYS,
        { ...AAD, ownerId: "64f0c2a9e1b2c3d4e5f60799" },
        PLATFORM_K1,
      );
      assert.fail("expected a decrypt error");
    } catch (error) {
      assert.ok(error instanceof TokenDecryptError);
      const text = `${error.message} ${String(error.stack)}`;
      assert.ok(!text.includes(TOKENS.accessToken));
      assert.ok(!text.includes(Buffer.alloc(32, 7).toString("base64")));
    }
  });
});
