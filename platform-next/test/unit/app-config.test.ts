import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigError,
  isOwnedDatabaseName,
  loadConfig,
} from "../../src/config/app-config";
import { testKeyEnv } from "../support/test-auth";

const KEY = testKeyEnv();
const VALID_ENV = {
  PORT: "4100",
  MONGODB_URI: "mongodb://localhost:27017/?replicaSet=rs0",
  CATALOG_DB_NAME: "truex_next_catalog",
  AUTH_ISSUER: "https://api.truex.test",
  AUTH_AUDIENCE: "truex-app",
  AUTH_SIGNING_KEY_ID: "k1",
  AUTH_SIGNING_KEY: KEY.privateKey,
  AUTH_ALLOWED_ORIGINS: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-secret-value",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/v1/auth/google/callback",
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return [...error.problems];
  }
  assert.fail("expected a ConfigError");
}

describe("loadConfig", () => {
  test("accepts a complete, valid environment", () => {
    const config = loadConfig(VALID_ENV);
    assert.equal(config.port, 4100);
    assert.equal(config.mongodbUri, VALID_ENV.MONGODB_URI);
    assert.equal(config.catalogDbName, "truex_next_catalog");
    assert.equal(config.auth.issuer, "https://api.truex.test");
    assert.equal(config.auth.audience, "truex-app");
    assert.equal(config.auth.signingKey.kid, "k1");
    assert.deepEqual([...config.auth.verifyKeys.keys()], ["k1"]);
    assert.deepEqual(config.auth.allowedOrigins, ["http://localhost:3000"]);
    assert.equal(config.auth.cookieSecure, false);
    assert.equal(config.google.clientId, VALID_ENV.GOOGLE_CLIENT_ID);
    assert.equal(config.google.redirectUri, VALID_ENV.GOOGLE_REDIRECT_URI);
    assert.equal(
      config.google.endpoints.token,
      "https://oauth2.googleapis.com/token",
    );
  });

  test("accepts mongodb+srv URIs", () => {
    const uri = "mongodb+srv://cluster.example.net/";
    assert.equal(
      loadConfig({ ...VALID_ENV, MONGODB_URI: uri }).mongodbUri,
      uri,
    );
  });

  test("lists every missing setting at once", () => {
    assert.deepEqual(problemsFor({}), [
      "PORT is required.",
      "MONGODB_URI is required.",
      "CATALOG_DB_NAME is required.",
      "AUTH_ISSUER is required.",
      "AUTH_AUDIENCE is required.",
      "AUTH_SIGNING_KEY_ID is required.",
      "AUTH_SIGNING_KEY is required. Run `npm run auth:generate-key` to create one.",
      "AUTH_ALLOWED_ORIGINS is required.",
      "GOOGLE_CLIENT_ID is required.",
      "GOOGLE_CLIENT_SECRET is required.",
      "GOOGLE_REDIRECT_URI is required.",
    ]);
  });

  for (const port of ["0", "65536", "-1", "4100.5", "abc", " "])
    test(`rejects PORT=${JSON.stringify(port)}`, () => {
      assert.match(problemsFor({ ...VALID_ENV, PORT: port })[0]!, /^PORT/);
    });

  test("rejects a non-MongoDB URI without echoing its value", () => {
    const secret = "postgres://user:hunter2@db/x";
    const problems = problemsFor({ ...VALID_ENV, MONGODB_URI: secret });
    assert.equal(problems.length, 1);
    assert.ok(!problems[0]!.includes("hunter2"));
  });

  test("refuses databases outside the owned namespace", () => {
    for (const name of ["truex_catalog", "truex_t_default", "admin"])
      assert.match(
        problemsFor({ ...VALID_ENV, CATALOG_DB_NAME: name })[0]!,
        /^CATALOG_DB_NAME/,
      );
  });
});

describe("auth configuration", () => {
  test("accepts previous verify keys for rotation", () => {
    const old = testKeyEnv();
    const config = loadConfig({
      ...VALID_ENV,
      AUTH_VERIFY_KEYS: `k0=${old.publicKey}`,
    });
    assert.deepEqual([...config.auth.verifyKeys.keys()].sort(), ["k0", "k1"]);
  });

  test("uses secure cookies when every origin is https", () => {
    const config = loadConfig({
      ...VALID_ENV,
      AUTH_ALLOWED_ORIGINS: "https://app.truex.test,https://www.truex.test",
      GOOGLE_REDIRECT_URI: "https://app.truex.test/api/v1/auth/google/callback",
    });
    assert.equal(config.auth.cookieSecure, true);
  });

  test("rejects a malformed or non-Ed25519 signing key without echoing it", () => {
    for (const bad of ["not-base64!", "AAAA", KEY.publicKey]) {
      const problems = problemsFor({ ...VALID_ENV, AUTH_SIGNING_KEY: bad });
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /^AUTH_SIGNING_KEY must/);
      assert.ok(!problems[0]!.includes(bad));
    }
  });

  test("rejects bad key IDs and verify-key lists", () => {
    assert.match(
      problemsFor({ ...VALID_ENV, AUTH_SIGNING_KEY_ID: "has space" })[0]!,
      /^AUTH_SIGNING_KEY_ID/,
    );
    for (const list of ["k0", "k0=AAAA", `k1=${KEY.publicKey}`])
      assert.match(
        problemsFor({ ...VALID_ENV, AUTH_VERIFY_KEYS: list })[0]!,
        /^AUTH_VERIFY_KEYS/,
        list,
      );
  });

  test("rejects origins that are not exact https or local http", () => {
    for (const origins of [
      "http://app.truex.test",
      "https://app.truex.test/",
      "https://app.truex.test/path",
      "*",
      "http://localhost:3000,https://app.truex.test",
    ])
      assert.match(
        problemsFor({ ...VALID_ENV, AUTH_ALLOWED_ORIGINS: origins })[0]!,
        /^AUTH_ALLOWED_ORIGINS/,
        origins,
      );
  });
});

describe("google configuration", () => {
  test("rejects a client ID that is not a Google OAuth client", () => {
    assert.match(
      problemsFor({ ...VALID_ENV, GOOGLE_CLIENT_ID: "my-client" })[0]!,
      /^GOOGLE_CLIENT_ID/,
    );
  });

  test("rejects a client secret with spaces without echoing it", () => {
    const problems = problemsFor({
      ...VALID_ENV,
      GOOGLE_CLIENT_SECRET: "has a space",
    });
    assert.equal(problems.length, 1);
    assert.ok(!problems[0]!.includes("has a space"));
  });

  test("the redirect URI must be exact and on an allowed origin", () => {
    for (const uri of [
      "/api/v1/auth/google/callback",
      "http://evil.test/callback",
      "https://app.truex.test/api/v1/auth/google/callback",
      "http://localhost:3000/callback?x=1",
      "http://localhost:3000/callback#x",
    ])
      assert.match(
        problemsFor({ ...VALID_ENV, GOOGLE_REDIRECT_URI: uri })[0]!,
        /^GOOGLE_REDIRECT_URI/,
        uri,
      );
  });
});

describe("isOwnedDatabaseName", () => {
  test("accepts prefixed lowercase names", () => {
    assert.ok(isOwnedDatabaseName("truex_next_catalog"));
    assert.ok(isOwnedDatabaseName("truex_next_t_65f1a2b3c4d5e6f7a8b9c0d1"));
  });

  test("rejects the bare prefix, other prefixes and unsafe characters", () => {
    for (const name of [
      "truex_next_",
      "truex_catalog",
      "TRUEX_NEXT_CATALOG",
      "truex_next_cat.alog",
      "truex_next_cat$alog",
      "truex_next_cat alog",
      "truex_next_" + "a".repeat(53),
      "",
    ])
      assert.equal(isOwnedDatabaseName(name), false, name);
  });
});
