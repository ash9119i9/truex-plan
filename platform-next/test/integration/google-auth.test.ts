import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { DatabaseService } from "../../src/database/database.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import {
  MEMBERSHIPS_COLLECTION,
  type MembershipDoc,
} from "../../src/modules/memberships/membership";
import { OperatorService } from "../../src/modules/operator/operator.service";
import {
  SESSIONS_COLLECTION,
  type SessionDoc,
} from "../../src/modules/sessions/session";
import { USERS_COLLECTION, type UserDoc } from "../../src/modules/users/user";
import { FakeGoogle } from "../support/fake-google";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";
import {
  TEST_GOOGLE_CLIENT_ID,
  TEST_ORIGIN,
  testGoogleConfig,
} from "../support/test-auth";

const FLOW_COOKIE = "truex_oauth";
const REFRESH_COOKIE = "truex_refresh";

interface Started {
  cookie: string; // "truex_oauth=..."
  state: string;
  nonce: string;
  challenge: string;
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

describe("Google sign-in", () => {
  let mongo: MongoMemoryReplSet;
  let google: FakeGoogle;
  let running: RunningApp;
  let database: DatabaseService;
  let operator: OperatorService;
  let defaultTenantId: ObjectId;

  before(async () => {
    mongo = await startReplicaSet();
    google = new FakeGoogle();
    await google.start();
    const base = testGoogleConfig();
    running = await startApp({
      mongodbUri: mongo.getUri(),
      google: {
        ...base,
        endpoints: {
          ...base.endpoints,
          token: `${google.baseUrl}/token`,
          jwks: `${google.baseUrl}/certs`,
        },
      },
    });
    database = running.app.get(DatabaseService);
    operator = running.app.get(OperatorService);
  });

  after(async () => {
    await running?.close();
    await google?.stop();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await resetOwnedData(database);
    google.tokenStatus = 200;
    defaultTenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId: defaultTenantId,
      name: "Truex",
      kind: "default",
    });
  });

  const catalog = () => database.catalog();
  const usersDocs = () =>
    catalog().collection<UserDoc>(USERS_COLLECTION).find({}).toArray();
  const membershipDocs = () =>
    catalog()
      .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION)
      .find({})
      .toArray();
  const sessionDocs = () =>
    catalog().collection<SessionDoc>(SESSIONS_COLLECTION).find({}).toArray();

  async function start(): Promise<Started> {
    const res = await fetch(`${running.baseUrl}/api/v1/auth/google`, {
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    const value = cookieValue(res, FLOW_COOKIE);
    assert.ok(value);
    return {
      cookie: `${FLOW_COOKIE}=${value}`,
      state: location.searchParams.get("state")!,
      nonce: location.searchParams.get("nonce")!,
      challenge: location.searchParams.get("code_challenge")!,
    };
  }

  function claimsFor(
    started: Started,
    subject = "g-alice",
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: "https://accounts.google.com",
      aud: TEST_GOOGLE_CLIENT_ID,
      azp: TEST_GOOGLE_CLIENT_ID,
      sub: subject,
      email: `${subject}@example.test`,
      email_verified: true,
      name: `User ${subject}`,
      nonce: started.nonce,
      iat: now,
      exp: now + 3600,
      ...overrides,
    };
  }

  function callback(
    query: Record<string, string>,
    cookie?: string,
  ): Promise<Response> {
    const url = new URL(`${running.baseUrl}/api/v1/auth/google/callback`);
    url.search = new URLSearchParams(query).toString();
    return fetch(url, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
  }

  // The whole browser journey for one Google account.
  async function signIn(
    subject = "g-alice",
    overrides: Record<string, unknown> = {},
  ): Promise<Response> {
    const started = await start();
    const code = google.issueCode({
      claims: claimsFor(started, subject, overrides),
      challenge: started.challenge,
    });
    return callback({ state: started.state, code }, started.cookie);
  }

  function failureOf(res: Response): string | null {
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin, TEST_ORIGIN);
    assert.equal(location.pathname, "/login");
    return location.searchParams.get("error");
  }

  test("start redirects to Google with state, nonce and PKCE", async () => {
    const res = await fetch(`${running.baseUrl}/api/v1/auth/google`, {
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const location = new URL(res.headers.get("location")!);
    assert.equal(
      `${location.origin}${location.pathname}`,
      "https://accounts.google.test/o/oauth2/v2/auth",
    );
    const q = location.searchParams;
    assert.equal(q.get("client_id"), TEST_GOOGLE_CLIENT_ID);
    assert.equal(
      q.get("redirect_uri"),
      `${TEST_ORIGIN}/api/v1/auth/google/callback`,
    );
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("scope"), "openid email profile");
    assert.equal(q.get("code_challenge_method"), "S256");
    for (const name of ["state", "nonce", "code_challenge"])
      assert.match(q.get(name) ?? "", /^[A-Za-z0-9_-]{43}$/, name);
    assert.notEqual(q.get("state"), q.get("nonce"));

    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${FLOW_COOKIE}=`));
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=600/);
    // The verifier never leaves the browser cookie for Google.
    const verifier = cookie.split(";")[0]!.split(".")[3]!;
    assert.equal(location.href.includes(verifier), false);
  });

  test("first sign-in creates one user, a default 'user' membership and a session", async () => {
    const res = await signIn();
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `${TEST_ORIGIN}/auth/complete`);
    // No token of any kind in the redirect.
    assert.equal(res.headers.get("location")!.includes("?"), false);
    assert.equal(cookieValue(res, FLOW_COOKIE), "");
    const refresh = cookieValue(res, REFRESH_COOKIE);
    assert.ok(refresh);

    const users = await usersDocs();
    assert.equal(users.length, 1);
    assert.equal(users[0]!.email, "g-alice@example.test");
    assert.deepEqual(users[0]!.identities, [
      { provider: "google", subject: "g-alice" },
    ]);
    assert.ok(users[0]!.lastLoginAt);

    const memberships = await membershipDocs();
    assert.equal(memberships.length, 1);
    assert.ok(memberships[0]!.tenantId.equals(defaultTenantId));
    assert.equal(memberships[0]!.role, "user");
    assert.equal(memberships[0]!.joinedVia, "signup");

    // The frontend's /auth/complete exchanges the cookie for an access token.
    const exchanged = await fetch(`${running.baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        cookie: `${REFRESH_COOKIE}=${refresh}`,
      },
    });
    assert.equal(exchanged.status, 200);
    const body = (await exchanged.json()) as { userId: string };
    assert.equal(body.userId, users[0]!._id.toHexString());

    const audit = await catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({ action: "auth.signup" })
      .toArray();
    assert.equal(audit.length, 1);
  });

  // The path the frontend takes after /auth/complete.
  test("after signup the app refreshes and is sent straight to the default tenant", async () => {
    const signedIn = await signIn();
    const refresh = await fetch(`${running.baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        cookie: `${REFRESH_COOKIE}=${cookieValue(signedIn, REFRESH_COOKIE)}`,
      },
    });
    assert.equal(refresh.status, 200);
    const { accessToken } = (await refresh.json()) as { accessToken: string };
    const auth = { authorization: `Bearer ${accessToken}` };

    const me = await fetch(`${running.baseUrl}/api/v1/me`, { headers: auth });
    assert.equal(me.status, 200);
    const { user } = (await me.json()) as { user: { email: string } };
    assert.equal(user.email, "g-alice@example.test");

    const tenants = await fetch(`${running.baseUrl}/api/v1/me/tenants`, {
      headers: auth,
    });
    assert.deepEqual(await tenants.json(), {
      entry: {
        outcome: "enterTenant",
        tenantId: defaultTenantId.toHexString(),
      },
      tenants: [
        { id: defaultTenantId.toHexString(), name: "Truex", role: "user" },
      ],
    });
  });

  test("returning sign-in reuses the account and membership", async () => {
    await signIn();
    const again = await signIn();
    assert.equal(again.headers.get("location"), `${TEST_ORIGIN}/auth/complete`);
    assert.equal((await usersDocs()).length, 1);
    assert.equal((await membershipDocs()).length, 1);
    assert.equal((await sessionDocs()).length, 2);
    const logins = await catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .countDocuments({ action: "auth.login" });
    assert.equal(logins, 1);
  });

  test("an admin keeps the admin role on later sign-ins", async () => {
    await signIn();
    const [user] = await usersDocs();
    await operator.assignRole({
      operator: "ops",
      user: user!.email,
      tenantId: defaultTenantId,
      role: "admin",
    });
    await signIn();
    const [membership] = await membershipDocs();
    assert.equal(membership!.role, "admin");
  });

  test("concurrent first sign-ins of one identity create one account and membership", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => signIn("g-race")),
    );
    for (const res of results)
      assert.equal(res.headers.get("location"), `${TEST_ORIGIN}/auth/complete`);
    assert.equal((await usersDocs()).length, 1);
    assert.equal((await membershipDocs()).length, 1);
  });

  test("a replayed callback cannot sign in twice", async () => {
    const started = await start();
    const code = google.issueCode({
      claims: claimsFor(started),
      challenge: started.challenge,
    });
    const query = { state: started.state, code };
    const first = await callback(query, started.cookie);
    assert.equal(first.headers.get("location"), `${TEST_ORIGIN}/auth/complete`);
    // Google refuses a used code even with the original cookie.
    assert.equal(failureOf(await callback(query, started.cookie)), "rejected");
    assert.equal((await sessionDocs()).length, 1);
  });

  test("a callback without the starting browser's cookie is refused before Google is called", async () => {
    const started = await start();
    const code = google.issueCode({
      claims: claimsFor(started),
      challenge: started.challenge,
    });
    const before = google.tokenRequests;
    // Login CSRF: an attacker's code delivered to a victim's browser.
    assert.equal(
      failureOf(await callback({ state: started.state, code })),
      "expired",
    );
    const other = await start();
    assert.equal(
      failureOf(await callback({ state: started.state, code }, other.cookie)),
      "expired",
    );
    assert.equal(
      failureOf(
        await callback({ state: "x".repeat(43), code }, started.cookie),
      ),
      "expired",
    );
    // Same character count as a real state, different byte length.
    assert.equal(
      failureOf(
        await callback({ state: "é".repeat(43), code }, started.cookie),
      ),
      "expired",
    );
    assert.equal(google.tokenRequests, before);
    assert.equal((await usersDocs()).length, 0);
  });

  test("a Google error or missing code maps to a fixed failure code", async () => {
    const started = await start();
    assert.equal(
      failureOf(
        await callback(
          { state: started.state, error: "access_denied" },
          started.cookie,
        ),
      ),
      "cancelled",
    );
    assert.equal(
      failureOf(
        await callback(
          { state: started.state, error: "<script>alert(1)</script>" },
          started.cookie,
        ),
      ),
      "rejected",
    );
    assert.equal(
      failureOf(await callback({ state: started.state }, started.cookie)),
      "rejected",
    );
  });

  test("a stolen code is useless without the PKCE verifier", async () => {
    const victim = await start();
    const code = google.issueCode({
      claims: claimsFor(victim),
      challenge: victim.challenge,
    });
    // The attacker has their own flow cookie and state, but not the victim's
    // verifier.
    const attacker = await start();
    assert.equal(
      failureOf(
        await callback({ state: attacker.state, code }, attacker.cookie),
      ),
      "rejected",
    );
    assert.equal((await usersDocs()).length, 0);
  });

  test("ID tokens failing any check grant no access", async () => {
    const cases: Array<[string, (s: Started) => Record<string, unknown>]> = [
      ["wrong nonce", () => ({ nonce: "n".repeat(43) })],
      ["wrong audience", () => ({ aud: "other.apps.googleusercontent.com" })],
      ["wrong azp", () => ({ azp: "other.apps.googleusercontent.com" })],
      ["wrong issuer", () => ({ iss: "https://evil.test" })],
      [
        "expired",
        () => ({
          iat: Math.floor(Date.now() / 1000) - 7200,
          exp: Math.floor(Date.now() / 1000) - 3600,
        }),
      ],
      ["unverified email", () => ({ email_verified: false })],
      ["email_verified as string", () => ({ email_verified: "true" })],
      ["missing sub", () => ({ sub: undefined })],
    ];
    for (const [label, change] of cases) {
      const started = await start();
      const code = google.issueCode({
        claims: { ...claimsFor(started), ...change(started) },
        challenge: started.challenge,
      });
      assert.equal(
        failureOf(
          await callback({ state: started.state, code }, started.cookie),
        ),
        "rejected",
        label,
      );
    }
    assert.equal((await usersDocs()).length, 0);
  });

  test("ID tokens with a bad signature or algorithm grant no access", async () => {
    const tokens: Array<[string, (s: Started) => string]> = [
      [
        "alg none",
        (s) => {
          const [h, p] = google
            .signIdToken(claimsFor(s), { alg: "none", kid: google.kid })
            .split(".");
          return `${h}.${p}.`;
        },
      ],
      [
        "HS256",
        (s) =>
          google.signIdToken(claimsFor(s), { alg: "HS256", kid: google.kid }),
      ],
      [
        "unknown kid",
        (s) => google.signIdToken(claimsFor(s), { alg: "RS256", kid: "nope" }),
      ],
      [
        "tampered claims",
        (s) => {
          const [h, , sig] = google.signIdToken(claimsFor(s)).split(".");
          const forged = Buffer.from(
            JSON.stringify(claimsFor(s, "g-mallory")),
          ).toString("base64url");
          return `${h}.${forged}.${sig}`;
        },
      ],
    ];
    for (const [label, build] of tokens) {
      const started = await start();
      const code = google.issueCode({
        claims: {},
        idToken: build(started),
        challenge: started.challenge,
      });
      assert.equal(
        failureOf(
          await callback({ state: started.state, code }, started.cookie),
        ),
        "rejected",
        label,
      );
    }
    assert.equal((await usersDocs()).length, 0);
  });

  test("Google being down is reported as retryable", async () => {
    google.tokenStatus = 503;
    assert.equal(failureOf(await signIn()), "unavailable");
    assert.equal((await usersDocs()).length, 0);
  });

  test("a disabled account cannot sign in", async () => {
    await signIn();
    await catalog()
      .collection(USERS_COLLECTION)
      .updateMany({}, { $set: { status: "disabled" } });
    const res = await signIn();
    assert.equal(failureOf(res), "account_disabled");
    assert.equal(cookieValue(res, REFRESH_COOKIE), undefined);
    assert.equal((await sessionDocs()).length, 1);
  });

  test("a removed membership is not restored by signing in", async () => {
    await signIn();
    await catalog()
      .collection(MEMBERSHIPS_COLLECTION)
      .updateMany({}, { $set: { status: "removed" } });
    const res = await signIn();
    // The login itself works; tenant discovery (4c) reports no usable tenant.
    assert.equal(res.headers.get("location"), `${TEST_ORIGIN}/auth/complete`);
    const [membership] = await membershipDocs();
    assert.equal(membership!.status, "removed");
  });

  test("an email already used by another account is refused", async () => {
    await signIn("g-first", { email: "shared@example.test" });
    const res = await signIn("g-second", { email: "Shared@Example.test" });
    assert.equal(failureOf(res), "email_in_use");
    assert.equal((await usersDocs()).length, 1);
    assert.equal((await membershipDocs()).length, 1);
  });

  test("signup without a usable default tenant creates nothing", async () => {
    await catalog()
      .collection("tenants")
      .updateMany({ kind: "default" }, { $set: { status: "disabled" } });
    assert.equal(failureOf(await signIn()), "signup_unavailable");
    assert.equal((await usersDocs()).length, 0);
    assert.equal((await membershipDocs()).length, 0);
  });

  test("signing in again on the same browser ends the previous session", async () => {
    const first = await signIn();
    const previous = cookieValue(first, REFRESH_COOKIE)!;
    const started = await start();
    const code = google.issueCode({
      claims: claimsFor(started),
      challenge: started.challenge,
    });
    await callback(
      { state: started.state, code },
      `${started.cookie}; ${REFRESH_COOKIE}=${previous}`,
    );
    const sessions = await sessionDocs();
    assert.equal(sessions.length, 2);
    assert.equal(
      sessions.filter((s) => s.revokedReason === "logout").length,
      1,
    );
  });
});
