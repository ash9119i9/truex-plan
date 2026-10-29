import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Binary, ObjectId } from "mongodb";
import type { ConnectorsConfig } from "../../src/config/connectors-config";
import {
  openTokens,
  sealTokens,
  TokenDecryptError,
  type SecretAad,
} from "../../src/modules/connectors/token-crypto";
import {
  codeChallengeOf,
  flowSecret,
  openConnectorFlow,
  sealConnectorFlow,
  stateMatches,
  type ConnectorFlow,
} from "../../src/modules/connectors/connector-oauth-flow";

function key(): Buffer {
  return randomBytes(32);
}

// A config with the given key ids; the first is active.
function configWith(...ids: string[]): ConnectorsConfig {
  const keys = new Map<string, Buffer>();
  for (const id of ids) keys.set(id, key());
  return {
    keys,
    activeKeyId: ids[0]!,
    redirectUri: "https://app.test/api/v1/connectors/callback",
    allowLoopback: true,
  };
}

function aad(): SecretAad {
  return {
    tenantId: new ObjectId().toHexString(),
    ownerId: new ObjectId().toHexString(),
    connectorId: new ObjectId().toHexString(),
  };
}

describe("token-crypto", () => {
  // Sealed by mcp-gateway's sealTokens (fixed key 0x07 x 32). Until the
  // gateway is the only key holder, both services open each other's rows;
  // mcp-gateway/test/token-crypto.test.ts holds the reverse vector.
  test("opens a token the MCP gateway sealed", () => {
    const config: ConnectorsConfig = {
      keys: new Map([["k1", Buffer.alloc(32, 7)]]),
      activeKeyId: "k1",
      redirectUri: "https://app.test/api/v1/connectors/callback",
      allowLoopback: false,
    };
    const bin = (b64: string) => new Binary(Buffer.from(b64, "base64"));
    const opened = openTokens(
      config,
      {
        tenantId: "64f0c2a9e1b2c3d4e5f60700",
        ownerId: "64f0c2a9e1b2c3d4e5f60718",
        connectorId: "64f0c2a9e1b2c3d4e5f60719",
      },
      {
        keyId: "k1",
        iv: bin("hPLCFAa4cuzZw5uZ"),
        tag: bin("1AHW+NMG3giQMLQySdjaGg=="),
        ciphertext: bin(
          "aQl8O6jNXoVgrk9gxjcL5ZPt+T9xwNk86BLsJFUvSGwFhwfFcrXSZuwQJbYsSZcAxM7N6iFA1+9zSKK303Mp+AVZDxeMZUFsuyWj6GcVB1jOiFbVFZVb",
        ),
      },
    );
    assert.deepEqual(opened, {
      accessToken: "gho_gateway_vector_access",
      refreshToken: "ghr_gateway_vector_refresh",
    });
  });

  test("round-trips an access and refresh token", () => {
    const config = configWith("k1");
    const binding = aad();
    const sealed = sealTokens(config, binding, {
      accessToken: "at-123",
      refreshToken: "rt-456",
    });
    assert.equal(sealed.keyId, "k1");
    const opened = openTokens(config, binding, sealed);
    assert.deepEqual(opened, { accessToken: "at-123", refreshToken: "rt-456" });
  });

  test("omits a refresh token that was not stored", () => {
    const config = configWith("k1");
    const binding = aad();
    const sealed = sealTokens(config, binding, { accessToken: "only-access" });
    const opened = openTokens(config, binding, sealed);
    assert.equal(opened.accessToken, "only-access");
    assert.equal("refreshToken" in opened, false);
  });

  test("a ciphertext copied to another owner fails to decrypt", () => {
    const config = configWith("k1");
    const owner = aad();
    const sealed = sealTokens(config, owner, { accessToken: "secret" });
    const otherOwner: SecretAad = {
      ...owner,
      ownerId: new ObjectId().toHexString(),
    };
    assert.throws(
      () => openTokens(config, otherOwner, sealed),
      TokenDecryptError,
    );
    // The same bytes under a different tenant or connector also fail.
    assert.throws(
      () =>
        openTokens(
          config,
          { ...owner, tenantId: new ObjectId().toHexString() },
          sealed,
        ),
      TokenDecryptError,
    );
    assert.throws(
      () =>
        openTokens(
          config,
          { ...owner, connectorId: new ObjectId().toHexString() },
          sealed,
        ),
      TokenDecryptError,
    );
  });

  test("key rotation: seal with the active key, decrypt after a new key is added", () => {
    const binding = aad();
    const old = configWith("kA");
    const sealed = sealTokens(old, binding, { accessToken: "rotatable" });

    // Config now has a new active key B but keeps A, so the old row still
    // opens; a new seal uses B.
    const rotated: ConnectorsConfig = {
      ...old,
      keys: new Map([
        ["kB", key()],
        ["kA", old.keys.get("kA")!],
      ]),
      activeKeyId: "kB",
    };
    assert.equal(openTokens(rotated, binding, sealed).accessToken, "rotatable");
    assert.equal(
      sealTokens(rotated, binding, { accessToken: "x" }).keyId,
      "kB",
    );
  });

  test("a retired key means the ciphertext can no longer be opened", () => {
    const binding = aad();
    const old = configWith("kA");
    const sealed = sealTokens(old, binding, { accessToken: "stranded" });
    const onlyNew = configWith("kB");
    assert.throws(
      () => openTokens(onlyNew, binding, sealed),
      TokenDecryptError,
    );
  });

  test("a tampered ciphertext fails the auth tag", () => {
    const config = configWith("k1");
    const binding = aad();
    const sealed = sealTokens(config, binding, { accessToken: "untampered" });
    sealed.ciphertext.buffer[0] = (sealed.ciphertext.buffer[0] ?? 0) ^ 0xff;
    assert.throws(() => openTokens(config, binding, sealed), TokenDecryptError);
  });
});

describe("connector-oauth-flow", () => {
  function flow(): ConnectorFlow {
    return {
      state: flowSecret(),
      codeVerifier: flowSecret(),
      connectorId: new ObjectId().toHexString(),
      connectorRevision: 3,
      slug: "github",
      tenantId: new ObjectId().toHexString(),
      userId: new ObjectId().toHexString(),
      dbName: "truex_next_t_default",
      startedAt: Math.floor(Date.now() / 1000),
    };
  }

  test("seals and opens a flow", () => {
    const config = configWith("k1");
    const original = flow();
    const opened = openConnectorFlow(
      config,
      sealConnectorFlow(config, original),
    );
    assert.deepEqual(opened, original);
  });

  test("a tampered cookie does not open", () => {
    const config = configWith("k1");
    const sealed = sealConnectorFlow(config, flow());
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    assert.equal(
      openConnectorFlow(config, bytes.toString("base64url")),
      undefined,
    );
  });

  test("a cookie sealed with a retired key does not open", () => {
    const sealed = sealConnectorFlow(configWith("kA"), flow());
    assert.equal(openConnectorFlow(configWith("kB"), sealed), undefined);
  });

  test("a cookie sealed with an old key still opens after rotation", () => {
    const old = configWith("kA");
    const sealed = sealConnectorFlow(old, flow());
    const rotated: ConnectorsConfig = {
      ...old,
      keys: new Map([
        ["kB", key()],
        ["kA", old.keys.get("kA")!],
      ]),
      activeKeyId: "kB",
    };
    assert.ok(openConnectorFlow(rotated, sealed));
  });

  test("absent, empty or oversized cookies return undefined", () => {
    const config = configWith("k1");
    assert.equal(openConnectorFlow(config, undefined), undefined);
    assert.equal(openConnectorFlow(config, ""), undefined);
    assert.equal(openConnectorFlow(config, "a".repeat(5000)), undefined);
  });

  test("stateMatches is constant-time and format-checked", () => {
    const state = flowSecret();
    assert.equal(stateMatches(state, state), true);
    assert.equal(stateMatches(state, flowSecret()), false);
    assert.equal(stateMatches(state, undefined), false);
    assert.equal(stateMatches(state, "short"), false);
    assert.equal(stateMatches(state, 123), false);
  });

  test("codeChallengeOf is the base64url SHA-256 of the verifier (PKCE S256)", () => {
    // A known RFC 7636 appendix-B vector.
    assert.equal(
      codeChallengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
