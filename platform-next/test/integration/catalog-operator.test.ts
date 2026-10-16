import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  parseOperatorCommand,
  readDefinition,
  runOperatorCommand,
  UsageError,
} from "../../src/cli/operator";
import { DomainError } from "../../src/common/domain-error";
import { DatabaseService } from "../../src/database/database.service";
import { BUILTIN_AGENTS_COLLECTION } from "../../src/modules/agents/builtin-agent";
import { BuiltinAgentsService } from "../../src/modules/agents/builtin-agents.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import {
  MODELS_COLLECTION,
  type ModelDoc,
} from "../../src/modules/models/model";
import { ModelsService } from "../../src/modules/models/models.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import {
  builtinDefinition,
  geminiDefinition,
  modelDefinition,
  TEST_SECRET_ARN,
} from "../support/catalog-fixtures";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

async function rejectsWith(
  promise: Promise<unknown>,
  code: DomainError["code"],
  pattern?: RegExp,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === code &&
      (!pattern || pattern.test(error.message)),
  );
}

describe("model and built-in agent catalog (operator)", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let operator: OperatorService;
  let models: ModelsService;
  let builtins: BuiltinAgentsService;

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({ mongodbUri: mongo.getUri() });
    database = running.app.get(DatabaseService);
    operator = running.app.get(OperatorService);
    models = running.app.get(ModelsService);
    builtins = running.app.get(BuiltinAgentsService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  beforeEach(() => resetOwnedData(database));

  const rawModel = (slug: string) =>
    database
      .catalog()
      .collection<ModelDoc>(MODELS_COLLECTION)
      .findOne({ slug });

  const audit = () =>
    database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({})
      .sort({ at: 1, _id: 1 })
      .toArray();

  const put = (definition: unknown, allowDevCredentials = false) =>
    operator.putModel({ operator: "ops", definition, allowDevCredentials });

  test("creates a model in the gateway's format and audits it", async () => {
    const { model, outcome } = await put(modelDefinition());
    assert.equal(outcome, "created");
    assert.equal(model.revision, 1);
    assert.equal(model.enabled, true);
    const stored = await rawModel("claude-sonnet");
    // Fields the gateway reads (model-gateway/src/adapter.ts).
    assert.equal(stored?.wireApi, "anthropic");
    assert.equal(stored?.baseUrl, "https://api.anthropic.com");
    assert.equal(stored?.modelName, "claude-sonnet-4-5");
    assert.equal(stored?.apiKeySecretArn, TEST_SECRET_ARN);
    assert.equal(stored?.enabled, true);
    assert.equal(stored?.maxOutputTokens, 16_000);
    const [event] = await audit();
    assert.equal(event?.action, "model.put");
    assert.equal(event?.result, "success");
    assert.equal(event?.details?.outcome, "created");
    assert.equal(event?.details?.slug, "claude-sonnet");
  });

  test("re-running an identical put changes nothing", async () => {
    await put(modelDefinition());
    const again = await put(
      modelDefinition({
        promptCache: { ttl: "5m", enabled: true, type: "anthropic" },
      }),
    );
    assert.equal(again.outcome, "unchanged");
    assert.equal(again.model.revision, 1);
  });

  test("updates display and limit fields and removes settings left out", async () => {
    await put(modelDefinition());
    const { outcome, model } = await put(
      modelDefinition({ displayName: "Claude Sonnet", promptCache: undefined }),
    );
    assert.equal(outcome, "updated");
    assert.equal(model.revision, 2);
    const stored = await rawModel("claude-sonnet");
    assert.equal(stored?.displayName, "Claude Sonnet");
    assert.equal("promptCache" in (stored ?? {}), false);
  });

  test("refuses to change a model's identity, which would switch existing chats", async () => {
    await put(modelDefinition());
    for (const change of [
      { modelName: "claude-opus-4-1" },
      { baseUrl: "https://proxy.example.test" },
      {
        wireApi: "chat",
        promptCache: undefined,
      },
    ])
      await rejectsWith(
        put(modelDefinition(change)),
        "CONFLICT",
        /cannot change/,
      );
    const stored = await rawModel("claude-sonnet");
    assert.equal(stored?.modelName, "claude-sonnet-4-5");
    assert.equal(stored?.revision, 1);
    const events = await audit();
    assert.deepEqual(
      events.map((e) => e.result),
      ["success", "denied", "denied", "denied"],
    );
  });

  test("invalid definitions are refused and audited without being stored", async () => {
    await rejectsWith(
      put(modelDefinition({ apiKeySecretArn: undefined, apiKey: "sk-live" })),
      "INVALID_INPUT",
    );
    assert.equal(await rawModel("claude-sonnet"), null);
    const [event] = await audit();
    assert.equal(event?.result, "denied");
    // The refusal reason never echoes the key.
    assert.doesNotMatch(JSON.stringify(event), /sk-live/);
  });

  test("a development key is stored only with the explicit flag and never printed", async () => {
    const definition = modelDefinition({
      apiKeySecretArn: undefined,
      apiKey: "sk-dev-only",
      baseUrl: "http://127.0.0.1:9999",
    });
    const result = await put(definition, true);
    assert.doesNotMatch(JSON.stringify(result), /sk-dev-only/);
    assert.equal((await rawModel("claude-sonnet"))?.apiKey, "sk-dev-only");
    const listing = await operator.listModels();
    assert.doesNotMatch(JSON.stringify(listing), /sk-dev-only|secretsmanager/);
    // The member-facing cache holds no credentials either.
    const cached = await models.enabledModels();
    assert.doesNotMatch(JSON.stringify(cached), /sk-dev-only/);
  });

  test("disabling is a soft delete and is safe to repeat", async () => {
    const { model } = await put(modelDefinition());
    const off = await operator.setModelEnabled({
      operator: "ops",
      slug: "claude-sonnet",
      enabled: false,
    });
    assert.equal(off.changed, true);
    const again = await operator.setModelEnabled({
      operator: "ops",
      slug: "claude-sonnet",
      enabled: false,
    });
    assert.equal(again.changed, false);
    const stored = await rawModel("claude-sonnet");
    assert.equal(stored?.enabled, false);
    assert.equal(stored?._id.toHexString(), model.id);
    assert.equal(await models.findEnabled(stored!._id), null);
    await rejectsWith(
      operator.setModelEnabled({
        operator: "ops",
        slug: "missing",
        enabled: true,
      }),
      "NOT_FOUND",
    );
  });

  test("enabled models are listed in sort order and a local change refreshes the cache", async () => {
    await put(geminiDefinition());
    await put(modelDefinition());
    assert.deepEqual(
      (await models.enabledModels()).map((m) => m.slug),
      ["claude-sonnet", "gemini-pro"],
    );
    await operator.setModelEnabled({
      operator: "ops",
      slug: "gemini-pro",
      enabled: false,
    });
    assert.deepEqual(
      (await models.enabledModels()).map((m) => m.slug),
      ["claude-sonnet"],
    );
  });

  test("concurrent creates of one slug leave exactly one model", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => put(modelDefinition())),
    );
    assert.ok(results.some((r) => r.status === "fulfilled"));
    // A loser either saw the winner's model (unchanged) or was told to rerun.
    for (const r of results)
      if (r.status === "rejected")
        assert.ok(
          r.reason instanceof DomainError && r.reason.code === "CONFLICT",
          String(r.reason),
        );
      else assert.notEqual(r.value.outcome, "updated");
    assert.equal(
      await database
        .catalog()
        .collection(MODELS_COLLECTION)
        .countDocuments({ slug: "claude-sonnet" }),
      1,
    );
  });

  test("a built-in agent references its model by slug and its prompt stays server-side", async () => {
    await put(modelDefinition());
    const { agent, outcome } = await operator.putBuiltinAgent({
      operator: "ops",
      definition: builtinDefinition(),
    });
    assert.equal(outcome, "created");
    const stored = await database
      .catalog()
      .collection(BUILTIN_AGENTS_COLLECTION)
      .findOne({ slug: "general" });
    assert.equal(stored?.instructions, builtinDefinition().instructions);
    assert.equal(
      stored?.modelId.toHexString(),
      (await rawModel("claude-sonnet"))?._id.toHexString(),
    );
    assert.equal("instructions" in agent, false);
    const listed = await builtins.enabledAgents();
    assert.equal(listed.length, 1);
    assert.equal("instructions" in listed[0]!, false);

    const same = await operator.putBuiltinAgent({
      operator: "ops",
      definition: builtinDefinition(),
    });
    assert.equal(same.outcome, "unchanged");
    const edited = await operator.putBuiltinAgent({
      operator: "ops",
      definition: builtinDefinition({ instructions: "Be brief." }),
    });
    assert.equal(edited.outcome, "updated");
    assert.equal(edited.agent.revision, 2);
  });

  test("a built-in agent needs an existing model", async () => {
    await rejectsWith(
      operator.putBuiltinAgent({
        operator: "ops",
        definition: builtinDefinition({ model: "nope" }),
      }),
      "MODEL_UNAVAILABLE",
    );
  });

  test("disabled built-ins leave the member listing", async () => {
    await put(modelDefinition());
    await operator.putBuiltinAgent({
      operator: "ops",
      definition: builtinDefinition(),
    });
    await operator.setBuiltinAgentEnabled({
      operator: "ops",
      slug: "general",
      enabled: false,
    });
    assert.deepEqual(await builtins.enabledAgents(), []);
    assert.equal((await operator.listBuiltinAgents()).length, 1);
  });

  test("the CLI reads a definition file and runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "truex-operator-"));
    try {
      const file = join(dir, "model.json");
      writeFileSync(file, JSON.stringify(modelDefinition()));
      const command = parseOperatorCommand([
        "model-put",
        "--operator",
        "ops",
        "--file",
        file,
      ]);
      const result = (await runOperatorCommand(operator, command)) as {
        outcome: string;
      };
      assert.equal(result.outcome, "created");
      writeFileSync(file, "{not json");
      assert.throws(() => readDefinition(file), UsageError);
      assert.throws(
        () => readDefinition(join(dir, "missing.json")),
        UsageError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseOperatorCommand (catalog)", () => {
  test("parses model and built-in commands", () => {
    assert.deepEqual(
      parseOperatorCommand([
        "model-put",
        "--operator",
        "ops",
        "--file",
        "m.json",
        "--allow-dev-credentials",
      ]),
      {
        command: "model-put",
        operator: "ops",
        file: "m.json",
        allowDevCredentials: true,
      },
    );
    assert.deepEqual(
      parseOperatorCommand([
        "model-disable",
        "--operator",
        "ops",
        "--slug",
        "x",
      ]),
      {
        command: "model-set-enabled",
        operator: "ops",
        slug: "x",
        enabled: false,
      },
    );
    assert.deepEqual(
      parseOperatorCommand([
        "builtin-agent-enable",
        "--operator",
        "ops",
        "--slug",
        "general",
      ]),
      {
        command: "builtin-agent-set-enabled",
        operator: "ops",
        slug: "general",
        enabled: true,
      },
    );
    assert.deepEqual(
      parseOperatorCommand(["model-list", "--operator", "ops"]),
      {
        command: "model-list",
        operator: "ops",
      },
    );
  });

  test("refuses missing flags", () => {
    assert.throws(
      () => parseOperatorCommand(["model-put", "--operator", "ops"]),
      UsageError,
    );
    assert.throws(
      () => parseOperatorCommand(["model-enable", "--operator", "ops"]),
      UsageError,
    );
  });
});
