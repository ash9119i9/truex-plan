import assert from "node:assert/strict";
import test from "node:test";
import { temporalSettings } from "../src/automation/connection";

test("Temporal connections use consistent namespace queue and safe defaults", async () => {
  const settings = await temporalSettings({});
  assert.deepEqual(settings, {
    connection: { address: "127.0.0.1:7233" },
    namespace: "default",
    taskQueue: "truex-automations",
  });
  assert.deepEqual(
    await temporalSettings({
      TEMPORAL_ADDRESS: "private.example:7233",
      TEMPORAL_NAMESPACE: "automation-pilot",
      TEMPORAL_TASK_QUEUE: "reviewed-workers",
    }),
    {
      connection: { address: "private.example:7233" },
      namespace: "automation-pilot",
      taskQueue: "reviewed-workers",
    },
  );
});

test("TLS client identity requires both certificate and key and explicit TLS", async () => {
  await assert.rejects(
    temporalSettings({ TEMPORAL_TLS_CERT_PATH: "/invalid/cert" }),
    /TLS/,
  );
  await assert.rejects(
    temporalSettings({
      TEMPORAL_TLS: "on",
      TEMPORAL_TLS_CERT_PATH: "/invalid/cert",
    }),
    /certificate and key/,
  );
  await assert.rejects(
    temporalSettings({ TEMPORAL_TLS: "maybe" }),
    /TEMPORAL_TLS/,
  );
});

test("worker refuses disabled admission before connecting infrastructure", async () => {
  const { runAutomationWorker } = await import("../src/automation/main");
  const original = process.env.AUTOMATIONS_ENABLED;
  process.env.AUTOMATIONS_ENABLED = "off";
  try {
    await assert.rejects(
      runAutomationWorker(),
      /requires AUTOMATIONS_ENABLED=on/,
    );
  } finally {
    if (original === undefined) delete process.env.AUTOMATIONS_ENABLED;
    else process.env.AUTOMATIONS_ENABLED = original;
  }
});

test("worker refuses standalone Mongo before connecting Temporal", async () => {
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const { runAutomationWorker } = await import("../src/automation/main");
  const mongo = await MongoMemoryServer.create();
  const keys = [
    "AUTOMATIONS_ENABLED",
    "MONGO_URI",
    "MONGO_DB",
    "CATALOG_MONGO_DB",
    "TEMPORAL_ADDRESS",
    "TEMPORAL_TLS",
    "TEMPORAL_TLS_CA_PATH",
    "TEMPORAL_TLS_CERT_PATH",
    "TEMPORAL_TLS_KEY_PATH",
    "TEMPORAL_TLS_SERVER_NAME",
    "TEMPORAL_API_KEY",
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    AUTOMATIONS_ENABLED: "on",
    MONGO_URI: mongo.getUri(),
    MONGO_DB: "automation_worker",
    CATALOG_MONGO_DB: "automation_worker",
    TEMPORAL_ADDRESS: "127.0.0.1:1",
    TEMPORAL_TLS: "off",
    TEMPORAL_TLS_CA_PATH: "",
    TEMPORAL_TLS_CERT_PATH: "",
    TEMPORAL_TLS_KEY_PATH: "",
    TEMPORAL_TLS_SERVER_NAME: "",
    TEMPORAL_API_KEY: "",
  });
  try {
    await assert.rejects(runAutomationWorker(), /replica-set transactions/);
  } finally {
    for (const [key, value] of original)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await mongo.stop();
  }
});

test("authenticated Temporal connection requires encrypted transport", async () => {
  await assert.rejects(
    temporalSettings({ TEMPORAL_API_KEY: "test-only" }),
    /API key requires TLS/,
  );
  const settings = await temporalSettings({
    TEMPORAL_API_KEY: "test-only",
    TEMPORAL_TLS: "on",
  });
  assert.equal(settings.connection.apiKey, "test-only");
  assert.ok(settings.connection.tls);
});
