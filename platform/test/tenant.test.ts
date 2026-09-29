import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  DEFAULT_TENANT_ID,
  TENANT_HEADER,
  devTenantResolver,
} from "../src/tenant";

const req = (headers: Record<string, string> = {}) =>
  ({
    get: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;

test("devTenantResolver: default tenant and DEV_TENANT_ID", () => {
  assert.equal(devTenantResolver({}).resolve(req()), DEFAULT_TENANT_ID);
  assert.equal(
    devTenantResolver({ DEV_TENANT_ID: " acme " }).resolve(req()),
    "acme",
  );
});

test("devTenantResolver: header override only when DEV_TENANT_HEADER=on", () => {
  const headers = { [TENANT_HEADER]: "globex" };
  assert.equal(devTenantResolver({}).resolve(req(headers)), DEFAULT_TENANT_ID);
  assert.equal(
    devTenantResolver({ DEV_TENANT_HEADER: "off" }).resolve(req(headers)),
    DEFAULT_TENANT_ID,
  );
  const resolver = devTenantResolver({
    DEV_TENANT_ID: "acme",
    DEV_TENANT_HEADER: "ON",
  });
  assert.equal(resolver.resolve(req(headers)), "globex");
  assert.equal(resolver.resolve(req()), "acme");
});

test("devTenantResolver: invalid ids are rejected", () => {
  const invalid = { status: 400, code: "INVALID_TENANT" };
  for (const id of ["Acme", "-acme", "a_b", "a".repeat(33), "../x"])
    assert.throws(() => devTenantResolver({ DEV_TENANT_ID: id }), invalid);
  const resolver = devTenantResolver({ DEV_TENANT_HEADER: "on" });
  for (const id of ["Acme", "a b", "x".repeat(33), "tenant/../db"])
    assert.throws(
      () => resolver.resolve(req({ [TENANT_HEADER]: id })),
      invalid,
    );
});

test("devTenantResolver: refuses production unless ALLOW_DEV_TENANT=on", () => {
  assert.throws(
    () => devTenantResolver({ NODE_ENV: "production" }),
    /cannot run in production/,
  );
  assert.throws(() =>
    devTenantResolver({ NODE_ENV: "production", ALLOW_DEV_TENANT: "off" }),
  );
  assert.equal(
    devTenantResolver({
      NODE_ENV: "production",
      ALLOW_DEV_TENANT: "on",
    }).resolve(req()),
    DEFAULT_TENANT_ID,
  );
});
