import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  DEV_USER_ID,
  ROLE_HEADER,
  USER_HEADER,
  authMode,
  currentUser,
  devUserResolver,
} from "../src/identity/user";
import { route, userMiddleware } from "../src/http/handlers";
import { currentTenant } from "../src/tenancy/tenant";

const req = (headers: Record<string, string> = {}) =>
  ({
    path: "/api/me",
    params: {},
    get: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;

test("devUserResolver: fixed dev user, admin by default", () => {
  assert.deepEqual(devUserResolver({}).resolve(req()), {
    id: DEV_USER_ID,
    email: `${DEV_USER_ID}@dev.local`,
    role: "admin",
  });
  assert.deepEqual(
    devUserResolver({
      DEV_USER_ID: " ashok ",
      DEV_USER_EMAIL: "ashok@gmail.com",
      DEV_USER_ROLE: "user",
    }).resolve(req()),
    { id: "ashok", email: "ashok@gmail.com", role: "user" },
  );
});

test("devUserResolver: header override only when DEV_USER_HEADER=on", () => {
  const headers = { [USER_HEADER]: "dharun", [ROLE_HEADER]: "admin" };
  assert.equal(devUserResolver({}).resolve(req(headers)).id, DEV_USER_ID);
  assert.equal(
    devUserResolver({ DEV_USER_HEADER: "off" }).resolve(req(headers)).id,
    DEV_USER_ID,
  );
  const resolver = devUserResolver({ DEV_USER_HEADER: "ON" });
  assert.deepEqual(resolver.resolve(req(headers)), {
    id: "dharun",
    email: "dharun@dev.local",
    role: "admin",
  });
  // A header user without a role header is an ordinary user.
  assert.equal(resolver.resolve(req({ [USER_HEADER]: "dharun" })).role, "user");
  assert.equal(resolver.resolve(req()).id, DEV_USER_ID);
});

test("devUserResolver: invalid ids and roles are rejected", () => {
  assert.throws(() => devUserResolver({ DEV_USER_ID: "a b" }), {
    status: 400,
    code: "INVALID_USER",
  });
  assert.throws(() => devUserResolver({ DEV_USER_ROLE: "owner" }), {
    status: 400,
    code: "INVALID_ROLE",
  });
  const resolver = devUserResolver({ DEV_USER_HEADER: "on" });
  for (const id of ["a/b", "x".repeat(65), "../x", "a.b"])
    assert.throws(() => resolver.resolve(req({ [USER_HEADER]: id })), {
      code: "INVALID_USER",
    });
  assert.throws(
    () =>
      resolver.resolve(req({ [USER_HEADER]: "dharun", [ROLE_HEADER]: "root" })),
    { code: "INVALID_ROLE" },
  );
});

test("devUserResolver: refuses production unless ALLOW_DEV_TENANT=on", () => {
  assert.throws(
    () => devUserResolver({ NODE_ENV: "production" }),
    /cannot run in production/,
  );
  assert.equal(
    devUserResolver({ NODE_ENV: "production", ALLOW_DEV_TENANT: "on" }).resolve(
      req(),
    ).id,
    DEV_USER_ID,
  );
});

test("authMode: dev by default, google only with its keys", () => {
  assert.equal(authMode({}), "dev");
  assert.equal(authMode({ AUTH_MODE: " POC ", NODE_ENV: "production" }), "poc");
  assert.equal(authMode({ AUTH_MODE: " DEV " }), "dev");
  assert.throws(() => authMode({ AUTH_MODE: "saml" }), /not supported/);
  assert.throws(
    () => authMode({ AUTH_MODE: "google" }),
    /requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FRONTEND_ORIGIN/,
  );
  assert.throws(
    () =>
      authMode({
        AUTH_MODE: "google",
        GOOGLE_CLIENT_ID: "id",
        FRONTEND_ORIGIN: "https://app.example.com",
      }),
    /requires GOOGLE_CLIENT_SECRET/,
  );
  assert.equal(
    authMode({
      AUTH_MODE: "Google",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      FRONTEND_ORIGIN: "https://app.example.com",
    }),
    "google",
  );
});

test("authMode: google placeholders like <from Google Cloud Console> are not values", () => {
  const ok = {
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "GOCSPX-real",
    FRONTEND_ORIGIN: "http://localhost:3000",
  };
  assert.equal(authMode(ok), "google");
  assert.throws(
    () => authMode({ ...ok, GOOGLE_CLIENT_ID: "<from Google Cloud Console>" }),
    /real values for GOOGLE_CLIENT_ID; found placeholder/,
  );
  assert.throws(
    () =>
      authMode({
        ...ok,
        GOOGLE_CLIENT_ID: " <id> ",
        GOOGLE_CLIENT_SECRET: "<secret>",
      }),
    /real values for GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/,
  );
  // Angle brackets inside a real-looking value are not a placeholder.
  assert.equal(authMode({ ...ok, GOOGLE_CLIENT_SECRET: "a<b>c" }), "google");
});

test("route: handlers run inside the resolved user and tenant", async () => {
  const request = req({ [USER_HEADER]: "ashok" });
  const res = { locals: { requestId: "r1" } } as unknown as Response;
  await new Promise<void>((resolve, reject) =>
    userMiddleware(devUserResolver({ DEV_USER_HEADER: "on" }))(
      request,
      res,
      (error?: unknown) => (error ? reject(error) : resolve()),
    ),
  );
  res.locals.tenant = { id: "t1", dbName: "truex_t_t1" };
  let seen: unknown;
  await route(() => {
    seen = { user: currentUser()?.id, tenant: currentTenant()?.id };
  })(request, res, (error?: unknown) => {
    throw error;
  });
  assert.deepEqual(seen, { user: "ashok", tenant: "t1" });
  assert.equal(currentUser(), undefined);
});

test("userMiddleware: resolver errors go to next", async () => {
  const res = { locals: {} } as unknown as Response;
  const error = await new Promise((resolve) =>
    userMiddleware(devUserResolver({ DEV_USER_HEADER: "on" }))(
      req({ [USER_HEADER]: "bad id" }),
      res,
      resolve,
    ),
  );
  assert.equal((error as { code?: string }).code, "INVALID_USER");
  assert.equal(res.locals.user, undefined);
});
