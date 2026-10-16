import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/common/domain-error";
import { TtlCache } from "../../src/common/ttl-cache";
import {
  parseCreateAgent,
  parseUpdateAgent,
  requestHashOf,
} from "../../src/modules/agents/agent";
import { parseBuiltinAgentSpec } from "../../src/modules/agents/builtin-agent";
import { parseModelSpec } from "../../src/modules/models/model";
import {
  TEST_SECRET_ARN as ARN,
  modelDefinition as claudeDefinition,
} from "../support/catalog-fixtures";

function refused(run: () => unknown, pattern: RegExp) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "INVALID_INPUT" &&
      pattern.test(error.message),
  );
}

describe("parseModelSpec", () => {
  test("accepts a complete gateway model", () => {
    const spec = parseModelSpec(claudeDefinition());
    assert.equal(spec.slug, "claude-sonnet");
    assert.equal(spec.apiKeySecretArn, ARN);
    assert.equal(spec.apiKey, undefined);
    assert.deepEqual(spec.promptCache, {
      type: "anthropic",
      enabled: true,
      ttl: "5m",
    });
  });

  test("normalizes a trailing slash on baseUrl", () => {
    const spec = parseModelSpec(
      claudeDefinition({ baseUrl: "https://example.test/v1/" }),
    );
    assert.equal(spec.baseUrl, "https://example.test/v1");
  });

  test("refuses unknown fields, so typos are not stored", () => {
    refused(
      () => parseModelSpec(claudeDefinition({ contextWindo: 1 })),
      /Unknown field "contextWindo"/,
    );
  });

  test("requires context limits and keeps them consistent", () => {
    const { contextWindow: _, ...missing } = claudeDefinition();
    refused(() => parseModelSpec(missing), /contextWindow/);
    refused(
      () =>
        parseModelSpec(claudeDefinition({ autoCompactTokenLimit: 200_000 })),
      /smaller than contextWindow/,
    );
    refused(
      () => parseModelSpec(claudeDefinition({ maxOutputTokens: 250_000 })),
      /maxOutputTokens must be smaller/,
    );
  });

  test("accepts only gateway routes", () => {
    refused(
      () => parseModelSpec(claudeDefinition({ wireApi: "responses" })),
      /wireApi/,
    );
  });

  test("needs exactly one credential, and plaintext only for development", () => {
    refused(
      () => parseModelSpec(claudeDefinition({ apiKeySecretArn: undefined })),
      /exactly one/,
    );
    refused(
      () => parseModelSpec(claudeDefinition({ apiKey: "sk-test" })),
      /local development only/,
    );
    refused(
      () =>
        parseModelSpec(
          claudeDefinition({ apiKeySecretArn: undefined, apiKey: "sk-test" }),
        ),
      /local development only/,
    );
    const dev = parseModelSpec(
      claudeDefinition({
        apiKeySecretArn: undefined,
        apiKey: "sk-test",
        baseUrl: "http://127.0.0.1:9999",
      }),
      { allowDevCredentials: true },
    );
    assert.equal(dev.apiKey, "sk-test");
    refused(
      () => parseModelSpec(claudeDefinition({ apiKeySecretArn: "my-secret" })),
      /Secrets Manager/,
    );
  });

  test("requires https and refuses URLs carrying credentials", () => {
    refused(
      () => parseModelSpec(claudeDefinition({ baseUrl: "http://api.test" })),
      /https/,
    );
    refused(
      () =>
        parseModelSpec(
          claudeDefinition({ baseUrl: "https://u:p@api.anthropic.com" }),
        ),
      /credentials/,
    );
    // Loopback http is only for development fixtures.
    refused(
      () => parseModelSpec(claudeDefinition({ baseUrl: "http://127.0.0.1:1" })),
      /https/,
    );
  });

  test("checks the prompt cache policy against the route, as the gateway does", () => {
    refused(
      () =>
        parseModelSpec(
          claudeDefinition({
            promptCache: { type: "chat", keyScope: "prefix" },
          }),
        ),
      /must match/,
    );
    refused(
      () =>
        parseModelSpec(
          claudeDefinition({ promptCache: { type: "anthropic", ttl: "2h" } }),
        ),
      /ttl/,
    );
    refused(
      () =>
        parseModelSpec(
          claudeDefinition({
            wireApi: "gemini",
            promptCache: { type: "anthropic" },
          }),
        ),
      /must match/,
    );
  });

  test("refuses invisible characters in display text", () => {
    refused(
      () =>
        parseModelSpec(claudeDefinition({ displayName: "Claude\u202eevil" })),
      /displayName/,
    );
  });
});

describe("parseBuiltinAgentSpec", () => {
  const general = {
    slug: "general",
    name: "General Agent",
    description: "Helps with anything.",
    instructions: "You are a helpful assistant.\nBe concise.",
    model: "claude-sonnet",
    look: 2,
    tint: "ice",
  };

  test("accepts a definition and keeps line breaks in instructions", () => {
    const spec = parseBuiltinAgentSpec(general);
    assert.equal(spec.instructions, general.instructions);
    assert.equal(spec.sortOrder, 100);
  });

  test("refuses bad looks, tints, slugs and empty instructions", () => {
    refused(() => parseBuiltinAgentSpec({ ...general, look: 12 }), /look/);
    refused(() => parseBuiltinAgentSpec({ ...general, tint: "red" }), /tint/);
    refused(
      () => parseBuiltinAgentSpec({ ...general, slug: "General" }),
      /slug/,
    );
    refused(
      () => parseBuiltinAgentSpec({ ...general, instructions: "  " }),
      /instructions/,
    );
    refused(
      () => parseBuiltinAgentSpec({ ...general, instructions: "a\u0000b" }),
      /instructions/,
    );
  });
});

describe("agent request bodies", () => {
  const body = {
    clientRequestId: "req-0001-abcdef",
    scope: "personal",
    name: "  Research Scout ",
    description: "Finds sources.",
    modelId: "64b7f0c2a1b2c3d4e5f60719",
  };

  test("create trims text and defaults the avatar", () => {
    const input = parseCreateAgent(body);
    assert.equal(input.name, "Research Scout");
    assert.equal(input.look, 2);
    assert.equal(input.tint, "ice");
  });

  test("create refuses missing or malformed fields", () => {
    refused(
      () => parseCreateAgent({ ...body, clientRequestId: "short" }),
      /clientRequestId/,
    );
    refused(() => parseCreateAgent({ ...body, scope: "public" }), /scope/);
    refused(() => parseCreateAgent({ ...body, name: "" }), /name/);
    refused(
      () => parseCreateAgent({ ...body, description: "x".repeat(281) }),
      /description/,
    );
    refused(() => parseCreateAgent({ ...body, modelId: "ABC" }), /modelId/);
    refused(
      () => parseCreateAgent({ ...body, instructions: "x" }),
      /Unknown field "instructions"/,
    );
    refused(() => parseCreateAgent([body]), /JSON object/);
    refused(() => parseCreateAgent(null), /JSON object/);
  });

  test("the request hash changes with the content, not the key order", () => {
    const a = requestHashOf(parseCreateAgent(body));
    const b = requestHashOf(
      parseCreateAgent({ ...body, name: "Research Scout" }),
    );
    const c = requestHashOf(parseCreateAgent({ ...body, name: "Other" }));
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test("update needs a revision and at least one change", () => {
    refused(() => parseUpdateAgent({ name: "X" }), /revision/);
    refused(() => parseUpdateAgent({ revision: 1 }), /at least one/);
    refused(() => parseUpdateAgent({ revision: 1, scope: "tenant" }), /scope/);
    assert.deepEqual(parseUpdateAgent({ revision: 3, tint: "mint" }), {
      revision: 3,
      changes: { tint: "mint" },
    });
  });
});

describe("TtlCache", () => {
  test("shares one load between concurrent readers and reuses it until expiry", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache(
      async () => ++loads,
      1_000,
      () => now,
    );
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(a, 1);
    assert.equal(b, 1);
    now = 999;
    assert.equal(await cache.get(), 1);
    now = 1_000;
    assert.equal(await cache.get(), 2);
  });

  test("does not keep a failed load", async () => {
    let fail = true;
    const cache = new TtlCache(async () => {
      if (fail) throw new Error("down");
      return "ok";
    }, 1_000);
    await assert.rejects(cache.get(), /down/);
    fail = false;
    assert.equal(await cache.get(), "ok");
  });

  test("a load started before clear() cannot refill the cache", async () => {
    let release!: (value: string) => void;
    let loads = 0;
    const cache = new TtlCache(() => {
      loads++;
      return loads === 1
        ? new Promise<string>((resolve) => (release = resolve))
        : Promise.resolve("fresh");
    }, 60_000);
    const stale = cache.get();
    cache.clear();
    release("stale");
    assert.equal(await stale, "stale");
    assert.equal(await cache.get(), "fresh");
  });
});
