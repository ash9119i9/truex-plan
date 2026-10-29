import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { MongoClient, type Collection } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createArgumentChecker, type StoredDefinition } from "../src/arguments";
import { reviewedDefinition, toolHash } from "../src/tool-hash";

// Task 11: tools/call arguments are checked against the reviewed input
// schema before the provider sees them.

const CREATE = {
  name: "create_issue",
  description: "Create an issue.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 100 },
      labels: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
    additionalProperties: false,
  },
};
// A draft-07 schema: `items` as an array means a tuple there.
const PAIR = {
  name: "set_pair",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
    },
  },
};

let mongo: MongoMemoryServer;
let client: MongoClient;
let definitions: Collection<StoredDefinition>;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  definitions = client
    .db("truex_next_catalog_args_test")
    .collection<StoredDefinition>("truex_mcp_tool_definitions");
});

after(async () => {
  await client.close();
  await mongo.stop();
});

beforeEach(async () => {
  await definitions.deleteMany({});
});

async function checkerWith(...tools: Record<string, unknown>[]) {
  const checker = createArgumentChecker({ definitions });
  for (const tool of tools)
    await checker.remember(toolHash(tool), reviewedDefinition(tool));
  return checker;
}

describe("argument checks", () => {
  test("arguments that match the schema pass; others are refused with the path", async () => {
    const checker = await checkerWith(CREATE);
    const hash = toolHash(CREATE);
    assert.deepEqual(
      await checker.check("create_issue", hash, {
        title: "Bug",
        labels: ["a"],
      }),
      { ok: true },
    );
    for (const args of [
      { title: 7 },
      { labels: ["a"] },
      { title: "Bug", extra: true },
      { title: "x".repeat(101) },
    ]) {
      const verdict = await checker.check("create_issue", hash, args);
      assert.equal(verdict.ok, false, JSON.stringify(args));
      if (verdict.ok) continue;
      assert.equal(verdict.reason, "invalid");
      assert.match(verdict.message, /create_issue/);
    }
    const typed = await checker.check("create_issue", hash, { title: 7 });
    assert.ok(!typed.ok && /\/title/.test(typed.message), "names the field");
  });

  test("missing arguments count as an empty object; a non-object is refused", async () => {
    const checker = await checkerWith(CREATE);
    const hash = toolHash(CREATE);
    const missing = await checker.check("create_issue", hash, undefined);
    assert.ok(!missing.ok && missing.reason === "invalid", "title is required");
    for (const args of [["Bug"], "Bug", 7, null]) {
      const verdict = await checker.check("create_issue", hash, args);
      assert.ok(
        !verdict.ok && verdict.reason === "not_object",
        JSON.stringify(args),
      );
    }
  });

  test("arguments over the size cap are refused before the schema", async () => {
    const checker = createArgumentChecker({
      definitions,
      maxArgumentBytes: 1024,
    });
    await checker.remember(toolHash(CREATE), reviewedDefinition(CREATE));
    const verdict = await checker.check("create_issue", toolHash(CREATE), {
      title: "x".repeat(2000),
    });
    assert.ok(!verdict.ok && verdict.reason === "too_large");
    assert.match(verdict.message, /1 KB/);
  });

  test("a tool the gateway never listed is refused", async () => {
    const checker = createArgumentChecker({ definitions });
    const verdict = await checker.check("create_issue", toolHash(CREATE), {
      title: "Bug",
    });
    assert.ok(!verdict.ok && verdict.reason === "unknown_tool");
  });

  test("another instance finds the definition through the shared store", async () => {
    await checkerWith(CREATE);
    const fresh = createArgumentChecker({ definitions });
    assert.deepEqual(
      await fresh.check("create_issue", toolHash(CREATE), { title: "Bug" }),
      { ok: true },
    );
    const invalid = await fresh.check("create_issue", toolHash(CREATE), {});
    assert.ok(!invalid.ok && invalid.reason === "invalid");
  });

  test("a stored definition that doesn't hash to its key is ignored", async () => {
    const hash = toolHash(CREATE);
    await definitions.insertOne({
      _id: hash,
      definition: reviewedDefinition({
        ...CREATE,
        inputSchema: { type: "object" },
      }),
      storedAt: new Date(),
    });
    const verdict = await createArgumentChecker({ definitions }).check(
      "create_issue",
      hash,
      { anything: true },
    );
    assert.ok(!verdict.ok && verdict.reason === "unknown_tool");
  });

  test("a schema that can't be compiled refuses the call", async () => {
    const broken = {
      name: "broken",
      inputSchema: { type: "object", properties: { a: { type: "nope" } } },
    };
    const checker = await checkerWith(broken);
    const verdict = await checker.check("broken", toolHash(broken), { a: 1 });
    assert.ok(!verdict.ok && verdict.reason === "schema_unusable");
  });

  test("draft-07 and 2020-12 schemas both work", async () => {
    const checker = await checkerWith(PAIR, CREATE);
    const hash = toolHash(PAIR);
    assert.deepEqual(
      await checker.check("set_pair", hash, { pair: ["a", 1] }),
      {
        ok: true,
      },
    );
    const verdict = await checker.check("set_pair", hash, { pair: [1, "a"] });
    assert.ok(!verdict.ok && verdict.reason === "invalid");
  });
});
