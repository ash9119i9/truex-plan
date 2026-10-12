// Loads the COMPILED (CommonJS) platform build the way production does and
// exercises strict bearer verification against an in-memory key set. No
// network, database or external service is contacted: the JWKS transport and
// the identity store are fixtures. Run after `npm --prefix platform run build`.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "platform/dist/platform/src/api-auth.js");
if (!existsSync(dist))
  throw new Error("Build first: npm --prefix platform run build");
const require = createRequire(path.join(root, "platform/package.json"));
const { SignJWT, generateKeyPair, exportJWK } = require("jose");
const api = require(dist);
const workload = require(
  path.join(root, "platform/dist/platform/src/workload-auth.js"),
);
assert.equal(typeof workload.WorkloadAuthenticator, "function");
const oidc = require(path.join(root, "platform/dist/platform/src/oidc.js"));
// Imports the installed openid-client ESM dependency through production CommonJS.
assert.equal(typeof oidc.oidcRoutes, "function");
assert.throws(
  () => oidc.oidcSettings({ OIDC_LOGIN_CONFIG: "invalid" }),
  /valid OIDC_LOGIN_CONFIG JSON/,
);

const ISS = "https://broker.smoke.invalid/";
const AUD = "https://api.smoke.invalid";
const JWKS = "https://broker.smoke.invalid/jwks.json";
const { privateKey, publicKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
new workload.WorkloadAuthenticator(
  {},
  { issuer: "https://worker.smoke.invalid/", keys: [{ ...jwk, use: "sig" }] },
);
const compiledRouter = oidc.oidcRoutes(
  { catalog: { collection: () => ({}) } },
  {
    connectionId: "broker",
    issuer: ISS,
    authorizationEndpoint: `${ISS}authorize`,
    tokenEndpoint: `${ISS}token`,
    jwksUri: JWKS,
    clientId: "browser",
    clientSecret: "synthetic-only",
    clientAuth: "basic",
    signingAlgorithm: "ES256",
    frontendOrigin: "https://app.smoke.invalid",
    sessionHours: 8,
  },
);
assert.equal(
  typeof compiledRouter,
  "function",
  "compiled OIDC configuration constructs with the installed SDK",
);
let fetched = 0;
const fixtureFetch = async (url) => {
  assert.equal(String(url), JWKS, "only the approved JWKS URL is fetched");
  fetched++;
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
};
const generation = "generation-1";
const identity = {
  resolveHuman: async (_c, issuer, subject) => {
    assert.equal(issuer, ISS);
    assert.equal(subject, "user-1");
    return {
      principal: { kind: "human", id: "person-1", generation },
      externalBindingId: "external-binding-1",
    };
  },
  validateCredential: async (input) => ({
    principal: input.principal,
    tenant: { id: input.tenantId, generation },
    binding: { id: input.bindingId, generation },
    connection: {},
  }),
};
const auth = new api.ApiAuthenticator(identity, {
  issuers: [
    { connectionId: "broker", issuer: ISS, jwksUri: JWKS, audience: AUD },
  ],
  fetch: fixtureFetch,
});
const now = Math.floor(Date.now() / 1000);
const mint = (typ = "at+jwt") =>
  new SignJWT({
    client_id: "app",
    scope: "agent.read",
    [api.COHORT_CLAIM]: {
      tenant: "acme",
      principal_generation: generation,
      binding_generation: generation,
      credential_generation: generation,
      tenant_generation: generation,
      connection_generation: generation,
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject("user-1")
    .setJti("smoke")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);

const ok = await auth.authenticate(`Bearer ${await mint()}`);
assert.equal(ok.kind, "human");
assert.deepEqual(ok.context.credential.scopes, ["agent.read"]);
await assert.rejects(auth.authenticate(`Bearer ${await mint("JWT")}`), {
  code: "BEARER_INVALID",
});
assert.deepEqual(api.bearerRouteRequirement("GET", "/api/agents"), {
  actions: ["agent.read"],
});
assert.equal(api.bearerRouteRequirement("GET", "/api/nope"), undefined);
assert.equal(fetched, 1);
console.log("authz compiled smoke: ok");
