import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyStructure, verifyPublicAndStore } from "./verify-structure";

const declaration = `configuration(id: string, { cwd, ownerId, use }: { cwd?: string; ownerId?: string; use?: boolean } = {})`;
const body = `{ return { id, cwd, ownerId, use }; }`;
const first = `http.get("/api/first", () => service.configuration("id"));`;
const second = `http.get("/api/second", () => service.configuration("id"));`;
const original = new Map([
  [
    "/virtual/original.ts",
    `class PlatformService { ${declaration} ${body} } async function main() { ${first} ${second} }`,
  ],
]);
const current = (
  forward = "{ cwd, ownerId, use }",
  routes = `${first} ${second}`,
  implementation = body,
) =>
  new Map([
    [
      "/virtual/current.ts",
      `
      class RuntimeConfiguration { ${declaration} ${implementation} }
      class PlatformService {
        private runtimeConfiguration: RuntimeConfiguration;
        constructor() { this.runtimeConfiguration = new RuntimeConfiguration(); }
        ${declaration} { return this.runtimeConfiguration.configuration(id, ${forward}); }
      }
      function registerRoutes(http: any, { service }: { service: PlatformService }) { ${routes} }
      async function main() { registerRoutes(http, { service }); }
    `,
    ],
  ]);

test("structure verifier preserves bodies, destructured forwarding and expanded registration order", () => {
  assert.deepEqual(verifyStructure(original, current()), {
    routes: 2,
    methods: 1,
    extracted: 1,
  });
});

test("structure verifier rejects omitted configuration arguments", () => {
  assert.throws(
    () => verifyStructure(original, current("{ cwd }")),
    /destructured argument forwarding/,
  );
});

test("structure verifier rejects altered bodies and registration order", () => {
  assert.throws(
    () =>
      verifyStructure(
        original,
        current(undefined, undefined, "{ return { id }; }"),
      ),
    /method body changed/,
  );
  assert.throws(
    () => verifyStructure(original, current(undefined, `${second} ${first}`)),
    /executable order changed/,
  );
});

test("structure verifier rejects forwarding into a different collaborator", () => {
  const changed = current();
  const source = changed.get("/virtual/current.ts")!;
  changed.set(
    "/virtual/current.ts",
    source.replace("new RuntimeConfiguration()", "new OtherConfiguration()"),
  );
  assert.throws(
    () => verifyStructure(original, changed),
    /wrong constructed collaborator/,
  );
});

const publicStorageOriginal = new Map([
  [
    "/virtual/original/public.ts",
    "const POLICY_VERSION = 1; function project(value: string) { return value; }",
  ],
  [
    "/virtual/original/store.ts",
    "class Store { get db() { return this.database; } savePlan() { return this.db; } }",
  ],
]);
const publicStorageCurrent = new Map([
  ["/virtual/current/public/policy.ts", "const POLICY_VERSION = 1;"],
  [
    "/virtual/current/public/conversation.ts",
    "function project(value: string) {\n return value;\n }",
  ],
  [
    "/virtual/current/persistence/store.ts",
    "class Store { get db() { return this.database; } }",
  ],
  [
    "/virtual/current/persistence/plans.ts",
    "function savePlan(this: Store) { return this.db; }",
  ],
]);

test("public/storage verification preserves relocated getters, initializers and function bodies", () => {
  assert.equal(
    verifyPublicAndStore(publicStorageOriginal, publicStorageCurrent),
    4,
  );
});

test("public/storage verification rejects altered constants and missing executable definitions", () => {
  const constantChanged = new Map(publicStorageCurrent);
  constantChanged.set(
    "/virtual/current/public/policy.ts",
    "const POLICY_VERSION = 2;",
  );
  assert.throws(
    () => verifyPublicAndStore(publicStorageOriginal, constantChanged),
    /executable body changed/,
  );
  const missingGetter = new Map(publicStorageCurrent);
  missingGetter.set("/virtual/current/persistence/store.ts", "class Store {}");
  assert.throws(
    () => verifyPublicAndStore(publicStorageOriginal, missingGetter),
    /Missing public\/storage implementation/,
  );
});
