import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import {
  checkMcpUrl,
  mcpConfig,
  mcpProfileUpdate,
  newMcpProfile,
} from "../src/mcp";
import { decryptSecret, encryptSecret } from "../src/secrets";
import {
  admin,
  asUser,
  fakeDns,
  insertFixtures,
  testEncryptionKey,
} from "./fixtures";

// Runs body with the given env overrides, then restores the previous values.
async function withEnv(
  values: Record<string, string | undefined>,
  body: () => unknown,
) {
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  const apply = (next: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(next))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  apply(values);
  try {
    await body();
  } finally {
    apply(saved);
  }
}
const noSecretFields = (value: unknown) =>
  assert.doesNotMatch(JSON.stringify(value), /apiKey|apikey|apiKeyEnc/);

test("MCP keys are AES-256-GCM encrypted, chosen by kid, and never stored without a key", async () => {
  const sealed = encryptSecret("top-secret");
  assert.equal(sealed.v, 1);
  assert.equal(sealed.kid, "k1");
  assert.equal(Buffer.from(sealed.iv, "base64").length, 12);
  assert.equal(Buffer.from(sealed.tag, "base64").length, 16);
  assert.doesNotMatch(JSON.stringify(sealed), /top-secret/);
  assert.notEqual(encryptSecret("top-secret").iv, sealed.iv);
  assert.equal(decryptSecret(sealed), "top-secret");
  // Tampering or relabelling fails authentication.
  assert.throws(
    () => decryptSecret({ ...sealed, data: Buffer.from("x").toString("base64") }),
    /could not be decrypted/,
  );
  // Rotation: the new key encrypts, the old one still decrypts by kid.
  const next = Buffer.alloc(32, 9).toString("base64");
  await withEnv(
    {
      MCP_ENCRYPTION_KEY: next,
      MCP_ENCRYPTION_KID: "k2",
      MCP_ENCRYPTION_KEYS: `k1:${testEncryptionKey}`,
    },
    () => {
      assert.equal(decryptSecret(sealed), "top-secret");
      const rotated = encryptSecret("new-secret");
      assert.equal(rotated.kid, "k2");
      assert.equal(decryptSecret(rotated), "new-secret");
    },
  );
  await withEnv(
    { MCP_ENCRYPTION_KEY: next, MCP_ENCRYPTION_KID: "k2" },
    () => assert.throws(() => decryptSecret(sealed), /k1, which is not configured/),
  );
  // No default or derived key: storing fails clearly.
  await withEnv({ MCP_ENCRYPTION_KEY: undefined }, () => {
    assert.throws(() => encryptSecret("x"), {
      code: "MCP_ENCRYPTION_NOT_CONFIGURED",
    });
    assert.throws(
      () =>
        newMcpProfile({
          name: "sap",
          transport: "http",
          url: "https://example.com/mcp",
          auth: { kind: "bearer" },
          apiKey: "secret",
        }),
      /MCP_ENCRYPTION_KEY is not configured/,
    );
  });
  for (const bad of ["short", Buffer.alloc(16).toString("base64"), "!!!!"])
    await withEnv({ MCP_ENCRYPTION_KEY: bad }, () =>
      assert.throws(() => encryptSecret("x"), /exactly 32 bytes/),
    );
});

test("MCP URLs to loopback, link-local, private and CGNAT addresses are rejected", async () => {
  for (const url of [
    "https://127.0.0.1/mcp",
    "https://127.1/mcp",
    "https://0x7f000001/mcp",
    "https://localhost:8080/mcp",
    "https://api.localhost/mcp",
    "https://10.2.3.4/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://172.20.0.1/mcp",
    "https://192.168.1.1/mcp",
    "https://100.64.1.1/mcp",
    "https://0.0.0.0/mcp",
    "https://[::1]/mcp",
    "https://[::]/mcp",
    "https://[fd00::1]/mcp",
    "https://[fc00::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[::ffff:8.8.8.8]/mcp",
  ])
    await assert.rejects(checkMcpUrl(url), /private network address/, url);
  for (const url of [
    "https://8.8.8.8/mcp",
    "https://203.0.113.5/mcp",
    "https://[2606:4700::1]/mcp",
    "https://example.com/mcp",
  ])
    assert.deepEqual(await checkMcpUrl(url), [], url);

  // Every resolved address counts, not just the first.
  fakeDns["mixed.example"] = ["203.0.113.20", "10.0.0.5"];
  await assert.rejects(
    checkMcpUrl("https://mixed.example/mcp"),
    /private network address/,
  );
  await assert.rejects(
    checkMcpUrl("https://nowhere.example/mcp"),
    /could not be resolved/,
  );
  await withEnv(
    { MCP_ALLOWED_PRIVATE_HOSTS: " Mixed.Example , localhost,10.2.3.4" },
    async () => {
      assert.deepEqual(await checkMcpUrl("https://mixed.example/mcp"), []);
      assert.deepEqual(await checkMcpUrl("https://localhost/mcp"), []);
      assert.deepEqual(await checkMcpUrl("https://10.2.3.4/mcp"), []);
    },
  );
  delete fakeDns["mixed.example"];

  // Plain HTTP warns, or fails with MCP_REQUIRE_HTTPS=on.
  assert.match(
    (await checkMcpUrl("http://example.com/mcp")).join(),
    /plain HTTP/,
  );
  await withEnv({ MCP_REQUIRE_HTTPS: "on" }, async () => {
    await assert.rejects(checkMcpUrl("http://example.com/mcp"), /HTTPS/);
    assert.deepEqual(await checkMcpUrl("https://example.com/mcp"), []);
  });
});

test("MCP input keeps known fields only and enforces the name rule", () => {
  const profile = newMcpProfile({
    name: "sap_prod-1",
    transport: "http",
    url: " https://example.com/mcp ",
    auth: { kind: "header", headerName: "x-api-key", extra: "dropped" },
    apiKey: "secret",
    capabilities: { requestTimeoutMs: 1500, retries: 9 },
    scope: "tenant",
    owner: "someone",
  });
  assert.deepEqual(Object.keys(profile).sort(), [
    "_id",
    "apiKeyEnc",
    "auth",
    "capabilities",
    "enabled",
    "name",
    "transport",
    "url",
  ]);
  assert.deepEqual(profile.auth, { kind: "header", headerName: "x-api-key" });
  assert.deepEqual(profile.capabilities, { requestTimeoutMs: 1500 });
  assert.equal(profile.url, "https://example.com/mcp");
  assert.doesNotMatch(JSON.stringify(profile), /secret/);

  const base = { transport: "http", url: "https://example.com/mcp" };
  for (const name of [
    "",
    "a__b",
    "_a",
    "a_",
    "a.b",
    "a b",
    "x".repeat(65),
    42,
  ])
    assert.throws(() => newMcpProfile({ ...base, name }), /MCP name/, String(name));
  assert.equal(newMcpProfile({ ...base, name: "x".repeat(64) }).name.length, 64);
  // mcpConfig applies the same rule to stored profiles.
  assert.throws(
    () => mcpConfig({ _id: "t", name: "a__b", ...base } as any),
    /MCP name/,
  );
  for (const [input, message] of [
    [{ config: { url: "https://example.com" } }, /config cannot be set/],
    [{ transport: "stdio", command: "node" }, /Local command/],
    [{ command: "node" }, /Local command/],
    [{ transport: "sse" }, /Transport must be http/],
    [{ auth: { kind: "oauth" } }, /Unsupported MCP authentication/],
    [{ auth: "bearer" }, /auth must be an object/],
    [{ auth: { kind: "header", headerName: "bad header" }, apiKey: "k" }, /headerName/],
    [{ auth: { kind: "header", headerName: "Host" }, apiKey: "k" }, /headerName/],
    [{ auth: { kind: "bearer" } }, /requires an API key/],
    [{ auth: { kind: "bearer" }, apiKey: "a\r\nb" }, /Invalid MCP API key/],
    [{ capabilities: { requestTimeoutMs: 0 } }, /requestTimeoutMs/],
    [{ capabilities: { connectTimeoutMs: 10_000_000 } }, /connectTimeoutMs/],
    [{ capabilities: { requestTimeoutMs: 1.5 } }, /requestTimeoutMs/],
    [{ url: "https://user:pw@example.com" }, /embedded credentials/],
  ] as const)
    assert.throws(
      () => newMcpProfile({ ...base, name: "sap", ...input }),
      message,
      JSON.stringify(input),
    );
  // The body the current MCP settings form sends still works.
  const form = newMcpProfile({
    name: "notion",
    transport: "http",
    url: "https://example.com/mcp",
    auth: { kind: "none" },
  });
  assert.deepEqual(form.auth, { kind: "none" });
  assert.equal(form.apiKeyEnc, undefined);
});

test("MCP updates re-encrypt rotated keys, drop legacy plain keys and refuse script-managed profiles", () => {
  const legacy = {
    _id: "mcp_1",
    name: "qlik",
    enabled: true,
    transport: "http" as const,
    url: "https://mcp.example/mcp",
    apiKey: "legacy-secret",
    auth: { kind: "header" as const, headerName: "x-api-qlik-key" },
  };
  // A rename leaves the stored credential alone.
  const renamed = mcpProfileUpdate(legacy, { name: "qlik-prod" });
  assert.deepEqual(renamed.set, { name: "qlik-prod" });
  assert.deepEqual(renamed.unset, {});
  // Rotation stores only apiKeyEnc and removes the legacy plain key.
  const rotated = mcpProfileUpdate(legacy, { apiKey: "rotated-secret" });
  assert.deepEqual(Object.keys(rotated.set), ["apiKeyEnc"]);
  assert.deepEqual(rotated.unset, { apiKey: "" });
  assert.equal(decryptSecret(rotated.set.apiKeyEnc), "rotated-secret");
  assert.doesNotMatch(JSON.stringify(rotated.set), /secret/);
  // Switching to no authentication drops every stored credential.
  const cleared = mcpProfileUpdate(
    { ...legacy, apiKeyEnc: rotated.set.apiKeyEnc },
    { auth: { kind: "none" } },
  );
  assert.deepEqual(cleared.unset, { apiKeyEnc: "", apiKey: "" });
  assert.throws(
    () => mcpProfileUpdate(legacy, { config: { url: "https://x.example" } }),
    /config cannot be set/,
  );
  assert.throws(
    () => mcpProfileUpdate(legacy, { name: "a__b" }),
    /MCP name/,
  );
  assert.throws(
    () =>
      mcpProfileUpdate(
        { ...legacy, config: { url: "https://mcp.example" } },
        { name: "x" },
      ),
    { code: "MCP_MANAGED" },
  );
});

test("MCP validation rejects unsupported transports, malformed auth and runtime config", () => {
  for (const input of [
    { transport: "sse", url: "https://example.com/sse" },
    { transport: "http", url: "file:///tmp/mcp" },
    { transport: "http", url: "https://user:secret@example.com" },
    {
      transport: "http",
      url: "https://example.com",
      auth: { kind: "header" },
      apiKey: "secret",
    },
    { transport: "http", url: "https://example.com", auth: { kind: "bearer" } },
    { transport: "stdio", command: "node", args: "bad" },
    { transport: "stdio", command: "node", env: { key: 42 } },
    {
      transport: "http",
      url: "https://example.com",
      capabilities: { requestTimeoutMs: -1 },
    },
    { config: { command: "node", url: "https://example.com" } },
  ])
    assert.throws(() =>
      mcpConfig({ _id: "test", name: "test", ...input } as any),
    );
  assert.deepEqual(
    mcpConfig(
      newMcpProfile({
        name: "sap",
        transport: "http",
        url: "https://example.com/mcp",
        auth: { kind: "bearer" },
        apiKey: "secret",
        capabilities: { requestTimeoutMs: 1500 },
      }),
    ),
    {
      url: "https://example.com/mcp",
      http_headers: { Authorization: "Bearer secret" },
      tool_timeout_sec: 1.5,
    },
  );
});

test(
  "MCP profiles persist, attach by ObjectId, isolate agents and never disclose credentials",
  { timeout: 120000 },
  // Tenant MCPs, managed by a tenant admin; they load in every chat.
  async (t) => asUser(admin, async () => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "mcp-test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store);
    const created = await service.createTenantMcp({
      name: "sap",
      transport: "http",
      url: "https://example.com/mcp?secret=hidden",
      auth: { kind: "header", headerName: "x-api-key" },
      apiKey: "secret-value",
    });
    // Only ciphertext is stored, and no response carries a key.
    assert.equal(created.hasKey, true);
    noSecretFields(created);
    assert.doesNotMatch(JSON.stringify(created), /secret-value/);
    const stored = await store.findMcp(created.id);
    assert.equal(stored?.apiKey, undefined);
    assert.equal(stored?.apikey, undefined);
    assert.equal(stored?.apiKeyEnc?.v, 1);
    assert.doesNotMatch(JSON.stringify(stored), /secret-value/);
    const plainHttp = await service.createTenantMcp({
      name: "plain",
      transport: "http",
      url: "http://example.com/mcp",
      auth: { kind: "none" },
    });
    assert.equal(plainHttp.hasKey, false);
    assert.match(plainHttp.warnings!.join(), /plain HTTP/);
    await assert.rejects(
      service.createTenantMcp({
        name: "metadata",
        transport: "http",
        url: "http://169.254.169.254/latest",
      }),
      /private network address/,
    );
    const updated = await service.updateTenantMcp(created.id, {
      apiKey: "rotated-value",
    });
    noSecretFields(updated);
    assert.doesNotMatch(JSON.stringify(updated), /rotated-value/);
    await assert.rejects(
      service.updateTenantMcp(created.id, { url: "https://10.0.0.8/mcp" }),
      /private network address/,
    );
    await assert.rejects(service.updateTenantMcp("missing", { name: "x" }), {
      status: 404,
    });
    await service.updateTenantMcp(created.id, { apiKey: "secret-value" });
    const localId = new ObjectId();
    await store.mcp.insertOne({
      _id: localId,
      name: "local",
      scope: "tenant",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { PASSWORD: "hidden-env" },
    });
    await assert.rejects(
      service.setAgentTenantMcp("assistant", [created.id, String(localId)]),
      /Local command/,
    );
    await service.setAgentTenantMcp("assistant", [created.id]);
    const listing = await service.agentTenantMcp("assistant");
    assert.deepEqual(listing.profileIds, [created.id]);
    assert.doesNotMatch(JSON.stringify(listing), /secret|hidden|server.js/);
    noSecretFields(listing);
    assert.equal(
      listing.profiles.find((p) => p.id === created.id)?.hasKey,
      true,
    );

    await service.setAgentTenantMcp("assistant", [created.id]);
    const config = await service.configuration("assistant");
    // Decrypted only here, at session build.
    assert.equal(
      config.config["mcp_servers.sap"].http_headers["x-api-key"],
      "secret-value",
    );
    // DNS rebinding: a host that now resolves privately fails the build.
    fakeDns["example.com"] = ["10.0.0.9"];
    await assert.rejects(
      service.configuration("assistant"),
      /private network address/,
    );
    fakeDns["example.com"] = ["203.0.113.10"];
    // A raw config written by a script is still honored at build time.
    await store.mcp.updateOne(
      { _id: created.id },
      {
        $set: {
          config: {
            url: "https://mcp.example/scripted",
            http_headers: { "x-scripted": "scripted-value" },
          },
        },
      },
    );
    assert.deepEqual(
      (await service.configuration("assistant")).config["mcp_servers.sap"],
      {
        url: "https://mcp.example/scripted",
        http_headers: { "x-scripted": "scripted-value" },
      },
    );
    await store.mcp.updateOne(
      { _id: created.id },
      { $unset: { config: "" } },
    );

    assert.match(
      config.baseInstructions,
      /discover and call the relevant tools/,
    );
    assert.match(
      config.baseInstructions,
      /Configured MCP server names for this agent: \["sap"\]/,
    );
    assert.doesNotMatch(config.baseInstructions, /secret|hidden|x-api-key/);
    assert.doesNotMatch(
      (await service.configuration("developer")).baseInstructions,
      /Configured MCP server names/,
    );
    assert.equal(
      Object.keys((await service.configuration("developer")).config).some((k) =>
        k.startsWith("mcp_servers"),
      ),
      false,
    );
    await assert.rejects(
      service.setAgentTenantMcp("assistant", ["missing"]),
      { status: 404, code: "MCP_NOT_FOUND" },
    );
    // Tenant names are unique (index), so a second "sap" cannot exist.
    await assert.rejects(
      service.createTenantMcp({
        name: "sap",
        transport: "http",
        url: "https://example.com/duplicate",
      }),
      { status: 409, code: "MCP_NAME_TAKEN" },
    );
    assert.deepEqual((await service.agentTenantMcp("assistant")).profileIds, [
      created.id,
    ]);
    // A disabled profile stays attached but is not loaded.
    await store.mcp.updateOne(
      { _id: created.id },
      { $set: { enabled: false } },
    );
    assert.equal(
      "mcp_servers.sap" in (await service.configuration("assistant")).config,
      false,
    );
    await service.setAgentTenantMcp("assistant", []);
    assert.deepEqual((await service.agentTenantMcp("assistant")).profileIds, []);
  }),
);

test(
  "a detached MCP profile is gone from the next turn's config, via a new fingerprint",
  { timeout: 120000 },
  async (t) => asUser(admin, async () => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "mcp-fingerprint").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store, ["http://core"]);
    const calls: { path: string; method?: string; body?: any }[] = [];
    service.call = async (_host, path, method, body) => {
      calls.push({ path, method, body });
      if (path === "/threads") return { threadId: "t1" };
      if (path.endsWith("/turns")) return { turnId: "turn_1", steer: false };
      return {};
    };
    const sap = await service.createTenantMcp({
      name: "sap",
      transport: "http",
      url: "https://example.com/mcp",
      auth: { kind: "bearer" },
      apiKey: "first-key",
    });
    await service.setAgentTenantMcp("assistant", [sap.id]);
    const attached = (await service.configuration("assistant")).mcpFingerprint;
    assert.match(attached, /^[0-9a-f]{64}$/);
    // Stable for the same servers; a new key, url or name changes it.
    assert.equal(
      (await service.configuration("assistant")).mcpFingerprint,
      attached,
    );
    await service.updateTenantMcp(sap.id, { apiKey: "second-key" });
    const rotated = (await service.configuration("assistant")).mcpFingerprint;
    assert.notEqual(rotated, attached);
    // Only the hash leaves the platform, never the key it covers.
    assert.doesNotMatch(rotated, /key/);

    const created = await service.create("assistant");
    assert.equal(calls[0].path, "/threads");
    assert.ok(calls[0].body.config["mcp_servers.sap"]);
    assert.equal(calls[0].body.mcpFingerprint, rotated);
    assert.equal(
      (await store.sessions.findOne({ _id: created._id }))?.mcpFingerprint,
      rotated,
    );

    await service.setAgentTenantMcp("assistant", []);
    calls.length = 0;
    await service.message(created._id, "hello", "client-1");
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/threads/t1/resume", "/threads/t1/turns"],
    );
    const resume = calls[0].body;
    assert.equal(
      Object.keys(resume.config).some((k) => k.startsWith("mcp_servers.")),
      false,
    );
    assert.notEqual(resume.mcpFingerprint, rotated);
    assert.equal(
      (await store.sessions.findOne({ _id: created._id }))?.mcpFingerprint,
      resume.mcpFingerprint,
    );
    // The next resume sends the same fingerprint, so agent-core keeps the thread.
    calls.length = 0;
    await service.message(created._id, "again", "client-2");
    assert.equal(calls[0].body.mcpFingerprint, resume.mcpFingerprint);
  }),
);
