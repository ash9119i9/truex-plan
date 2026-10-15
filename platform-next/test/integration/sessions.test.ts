import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { APP_CONFIG, type AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import { signAccessToken } from "../../src/modules/sessions/access-token";
import {
  SESSIONS_COLLECTION,
  type SessionDoc,
} from "../../src/modules/sessions/session";
import {
  REFRESH_RACE_GRACE_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from "../../src/modules/sessions/session-policy";
import {
  InvalidSessionError,
  RefreshRaceError,
  SessionsService,
} from "../../src/modules/sessions/sessions.service";
import { USERS_COLLECTION } from "../../src/modules/users/user";
import { UsersService } from "../../src/modules/users/users.service";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";
import { TEST_ORIGIN } from "../support/test-auth";

const T0 = new Date("2026-10-15T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("sessions", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let users: UsersService;
  let sessions: SessionsService;

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({ mongodbUri: mongo.getUri() });
    database = running.app.get(DatabaseService);
    users = running.app.get(UsersService);
    sessions = running.app.get(SessionsService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  beforeEach(() => resetOwnedData(database));

  // Synthetic identity only.
  async function newUser(subject = "s1"): Promise<ObjectId> {
    const { user } = await users.findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: `User ${subject}`,
    });
    return user._id;
  }

  function sessionDoc(id: ObjectId): Promise<SessionDoc | null> {
    return database
      .catalog()
      .collection<SessionDoc>(SESSIONS_COLLECTION)
      .findOne({ _id: id });
  }

  async function disable(userId: ObjectId): Promise<void> {
    await database
      .catalog()
      .collection(USERS_COLLECTION)
      .updateOne({ _id: userId }, { $set: { status: "disabled" } });
  }

  const invalid = (promise: Promise<unknown>) =>
    assert.rejects(promise, InvalidSessionError);

  describe("service", () => {
    test("create stores only a hash and issues a usable access token", async () => {
      const userId = await newUser();
      const issued = await sessions.create(userId, T0);
      const doc = await sessionDoc(issued.sessionId);
      assert.ok(doc);
      const secret = issued.refreshCredential.split(".")[1]!;
      assert.equal(JSON.stringify(doc).includes(secret), false);
      assert.equal(doc.generation, 0);
      assert.equal(
        doc.absoluteExpiresAt.getTime(),
        T0.getTime() + SESSION_ABSOLUTE_TTL_MS,
      );
      assert.equal(
        issued.refreshExpiresAt.getTime(),
        T0.getTime() + SESSION_IDLE_TTL_MS,
      );
      const caller = await sessions.authenticate(issued.accessToken, at(1000));
      assert.ok(caller.userId.equals(userId));
      assert.ok(caller.sessionId.equals(issued.sessionId));
    });

    test("refresh rotates the credential and extends the idle expiry", async () => {
      const first = await sessions.create(await newUser(), T0);
      const second = await sessions.refresh(
        first.refreshCredential,
        at(60_000),
      );
      assert.notEqual(second.refreshCredential, first.refreshCredential);
      assert.ok(second.sessionId.equals(first.sessionId));
      assert.equal(
        second.refreshExpiresAt.getTime(),
        at(60_000).getTime() + SESSION_IDLE_TTL_MS,
      );
      assert.equal((await sessionDoc(first.sessionId))?.generation, 1);
      const third = await sessions.refresh(
        second.refreshCredential,
        at(120_000),
      );
      assert.ok(third.accessToken);
    });

    test("rejects malformed and unknown credentials", async () => {
      for (const value of [
        undefined,
        "",
        "nonsense",
        `${new ObjectId().toHexString()}.${"a".repeat(43)}`,
        `${new ObjectId().toHexString().toUpperCase()}.${"a".repeat(43)}`,
      ])
        await invalid(sessions.refresh(value, T0));
    });

    test("a wrong secret for a real session revokes nothing", async () => {
      const issued = await sessions.create(await newUser(), T0);
      const forged = `${issued.sessionId.toHexString()}.${"b".repeat(43)}`;
      await invalid(sessions.refresh(forged, at(1000)));
      await sessions.logout(forged, at(1000));
      assert.equal((await sessionDoc(issued.sessionId))?.revokedAt, undefined);
      await sessions.refresh(issued.refreshCredential, at(2000));
    });

    test("concurrent refreshes: exactly one wins, the rest are races", async () => {
      const issued = await sessions.create(await newUser(), T0);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          sessions.refresh(issued.refreshCredential, at(1000)),
        ),
      );
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      assert.equal(won.length, 1);
      for (const r of lost)
        assert.ok(
          (r as PromiseRejectedResult).reason instanceof RefreshRaceError,
        );
      // The race did not end the session.
      const winner = (
        won[0] as PromiseFulfilledResult<{
          refreshCredential: string;
        }>
      ).value;
      await sessions.refresh(winner.refreshCredential, at(2000));
    });

    test("a just-rotated credential is a race inside the grace window", async () => {
      const first = await sessions.create(await newUser(), T0);
      const second = await sessions.refresh(first.refreshCredential, at(1000));
      await assert.rejects(
        sessions.refresh(
          first.refreshCredential,
          at(1000 + REFRESH_RACE_GRACE_MS),
        ),
        RefreshRaceError,
      );
      assert.equal((await sessionDoc(first.sessionId))?.revokedAt, undefined);
      await sessions.refresh(second.refreshCredential, at(2000));
    });

    test("replay after the grace window revokes the whole session and audits it", async () => {
      const userId = await newUser();
      const first = await sessions.create(userId, T0);
      const second = await sessions.refresh(first.refreshCredential, at(1000));
      const replayAt = at(1000 + REFRESH_RACE_GRACE_MS + 1);
      await invalid(sessions.refresh(first.refreshCredential, replayAt));

      const doc = await sessionDoc(first.sessionId);
      assert.equal(doc?.revokedReason, "refresh_reuse");
      await invalid(sessions.refresh(second.refreshCredential, replayAt));
      await invalid(sessions.authenticate(second.accessToken, replayAt));

      const events = await database
        .catalog()
        .collection<AuditDoc>(AUDIT_COLLECTION)
        .find({ action: "session.refresh_reuse" })
        .toArray();
      assert.equal(events.length, 1);
      assert.ok(events[0]!.targetUserId?.equals(userId));
      assert.equal(
        JSON.stringify(events).includes(first.refreshCredential),
        false,
      );
    });

    test("idle expiry ends the session; activity cannot pass the absolute expiry", async () => {
      const idle = await sessions.create(await newUser("idle"), T0);
      await invalid(
        sessions.refresh(idle.refreshCredential, at(SESSION_IDLE_TTL_MS)),
      );

      let current = await sessions.create(await newUser("busy"), T0);
      const step = SESSION_IDLE_TTL_MS - 60_000;
      let now = 0;
      while (now + step < SESSION_ABSOLUTE_TTL_MS) {
        now += step;
        current = await sessions.refresh(current.refreshCredential, at(now));
        assert.ok(
          current.refreshExpiresAt.getTime() <=
            T0.getTime() + SESSION_ABSOLUTE_TTL_MS,
        );
      }
      await invalid(
        sessions.refresh(
          current.refreshCredential,
          at(SESSION_ABSOLUTE_TTL_MS),
        ),
      );
    });

    test("a disabled account cannot refresh or authenticate", async () => {
      const userId = await newUser();
      const issued = await sessions.create(userId, T0);
      await disable(userId);
      await invalid(sessions.authenticate(issued.accessToken, at(1000)));
      await invalid(sessions.refresh(issued.refreshCredential, at(1000)));
      assert.equal(
        (await sessionDoc(issued.sessionId))?.revokedReason,
        "account_disabled",
      );
    });

    test("logout revokes, is repeatable, and kills the live access token", async () => {
      const issued = await sessions.create(await newUser(), T0);
      await sessions.logout(issued.refreshCredential, at(1000));
      await sessions.logout(issued.refreshCredential, at(2000));
      await sessions.logout(undefined, at(2000));
      assert.equal(
        (await sessionDoc(issued.sessionId))?.revokedReason,
        "logout",
      );
      await invalid(sessions.authenticate(issued.accessToken, at(3000)));
      await invalid(sessions.refresh(issued.refreshCredential, at(3000)));
    });

    test("an access token naming another user's session is rejected", async () => {
      const victim = await sessions.create(await newUser("victim"), T0);
      const attacker = await newUser("attacker");
      // Correctly signed, but sub and sid do not belong together.
      const { token } = signAccessToken(
        running.app.get<AppConfig>(APP_CONFIG).auth,
        { userId: attacker, sessionId: victim.sessionId },
        T0,
      );
      await invalid(sessions.authenticate(token, at(1000)));
    });
  });

  describe("HTTP", () => {
    const COOKIE = "truex_refresh";

    function post(
      path: string,
      init: { origin?: string; cookie?: string } = {},
    ): Promise<Response> {
      const headers: Record<string, string> = {};
      if (init.origin) headers.origin = init.origin;
      if (init.cookie) headers.cookie = init.cookie;
      return fetch(`${running.baseUrl}/api/v1/auth/${path}`, {
        method: "POST",
        headers,
      });
    }

    function setCookie(res: Response): string {
      const values = res.headers.getSetCookie();
      assert.equal(values.length, 1);
      return values[0]!;
    }

    test("refresh returns a new access token and rotates the cookie", async () => {
      const issued = await sessions.create(await newUser());
      const res = await post("refresh", {
        origin: TEST_ORIGIN,
        cookie: `other=1; ${COOKIE}=${issued.refreshCredential}`,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = (await res.json()) as Record<string, string>;
      assert.equal(body.userId, issued.userId.toHexString());
      assert.ok(body.accessToken);
      assert.ok(Date.parse(body.accessTokenExpiresAt!) > Date.now());
      const cookie = setCookie(res);
      assert.match(cookie, /^truex_refresh=[0-9a-f]{24}\.[A-Za-z0-9_-]{43}; /);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Path=\//);
      assert.equal(cookie.includes(issued.refreshCredential), false);
      // The access token is not in the cookie, and the secret not in the body.
      assert.equal(cookie.includes(body.accessToken!), false);
      await sessions.authenticate(body.accessToken);
    });

    test("cookie endpoints refuse a missing or foreign origin", async () => {
      const issued = await sessions.create(await newUser());
      const cookie = `${COOKIE}=${issued.refreshCredential}`;
      for (const origin of [undefined, "https://evil.test", "null"]) {
        for (const path of ["refresh", "logout"]) {
          const res = await post(path, { origin, cookie });
          assert.equal(res.status, 403, `${path} ${origin}`);
          assert.equal(
            ((await res.json()) as { error: { code: string } }).error.code,
            "FORBIDDEN",
          );
        }
      }
      // Nothing was rotated or revoked.
      const doc = await sessionDoc(issued.sessionId);
      assert.equal(doc?.generation, 0);
      assert.equal(doc?.revokedAt, undefined);
    });

    test("an invalid session answers 401 and clears the cookie", async () => {
      for (const cookie of [
        undefined,
        `${COOKIE}=garbage`,
        `${COOKIE}=${new ObjectId().toHexString()}.${"a".repeat(43)}`,
      ]) {
        const res = await post("refresh", { origin: TEST_ORIGIN, cookie });
        assert.equal(res.status, 401);
        assert.equal(
          ((await res.json()) as { error: { code: string } }).error.code,
          "UNAUTHENTICATED",
        );
        assert.match(setCookie(res), /^truex_refresh=; .*Max-Age=0/);
      }
    });

    test("two copies of the refresh cookie are not trusted", async () => {
      const issued = await sessions.create(await newUser());
      const c = `${COOKIE}=${issued.refreshCredential}`;
      const res = await post("refresh", {
        origin: TEST_ORIGIN,
        cookie: `${c}; ${c}`,
      });
      assert.equal(res.status, 401);
    });

    test("a losing concurrent refresh answers 409 and keeps the cookie", async () => {
      const issued = await sessions.create(await newUser());
      const cookie = `${COOKIE}=${issued.refreshCredential}`;
      const [a, b] = await Promise.all([
        post("refresh", { origin: TEST_ORIGIN, cookie }),
        post("refresh", { origin: TEST_ORIGIN, cookie }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const loser = a.status === 409 ? a : b;
      assert.deepEqual(loser.headers.getSetCookie(), []);
    });

    test("logout answers 204, clears the cookie and is repeatable", async () => {
      const issued = await sessions.create(await newUser());
      const cookie = `${COOKIE}=${issued.refreshCredential}`;
      for (let i = 0; i < 2; i++) {
        const res = await post("logout", { origin: TEST_ORIGIN, cookie });
        assert.equal(res.status, 204);
        assert.match(setCookie(res), /^truex_refresh=; .*Max-Age=0/);
      }
      const res = await post("refresh", { origin: TEST_ORIGIN, cookie });
      assert.equal(res.status, 401);
    });
  });
});
