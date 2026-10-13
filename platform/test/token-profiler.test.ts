import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  captureProxy,
  report,
  splitRequest,
  usageOf,
  type Call,
} from "../scripts/profile-agent-tokens";

test("request split associates actual context/schema/tool data with original size estimates", () => {
  const parts = splitRequest({
    instructions: "instruction secret",
    input: [
      { role: "user", content: "question" },
      { role: "developer", content: "policy" },
      { type: "function_call_output", output: "tool data" },
      { type: "function_call", arguments: "{}" },
    ],
    tools: [{ type: "function", name: "sap_read", description: "long schema" }],
  });
  assert.deepEqual(
    parts.map((p) => p.label),
    [
      "Instructions (platform + Codex runtime)",
      "User messages / environment context",
      "developer instructions",
      "Tool results",
      "Tool call arguments/history",
      "Tool schema: sap_read",
    ],
  );
  assert.ok(parts.every((p) => p.chars > 0 && p.estimatedTokens > 0));
  assert.equal(parts[0].data, "instruction secret");
  assert.deepEqual(parts[4].data, { type: "function_call", arguments: "{}" });
});

test("usage and report preserve subset accounting and mark missing calls", () => {
  assert.equal(usageOf({}), null);
  const usage = usageOf({
    input_tokens: 100,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens_details: { reasoning_tokens: 20 },
  });
  const md = report({
    calls: [
      { index: 1, parts: [], usage },
      { index: 2, parts: [], usage: null },
    ],
    inventory: [],
  });
  assert.match(md, /Input overall \| 100/);
  assert.match(md, /Uncached input \| 20/);
  assert.match(md, /Other output \| 10/);
  assert.match(md, /Total \| 130/);
  assert.match(md, /1\/2 captured HTTP attempts/);
  assert.match(
    report({ calls: [], inventory: [] }),
    /Input overall \| Unavailable/,
  );
});

test("proxy forwards credentials and exact stream bytes; fragmented duplicate usage is counted once", async () => {
  const frames = [
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [{ type: "output_text", text: "fixture reply" }],
      },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 12, output_tokens: 7 } },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 12, output_tokens: 7 } },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const provider = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    for await (const _chunk of req) {
      /* consume the forwarded body */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Break JSON and CRLF boundaries to exercise incremental parsing.
    for (let offset = 0; offset < frames.length; offset += 13)
      res.write(frames.slice(offset, offset + 13));
    res.end();
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const calls: Call[] = [];
  const proxy = await captureProxy(
    `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    calls,
    5000,
  );
  try {
    const response = await fetch(proxy.url + "/responses", {
      method: "POST",
      headers: { authorization: "Bearer fixture-key" },
      body: JSON.stringify({ instructions: "fixture", input: "Hello" }),
    });
    assert.equal(await response.text(), frames);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].usage?.total, 19);
    assert.equal(calls[0].outputParts?.length, 1);
    assert.ok(calls[0].request);
    assert.ok(calls[0].responseBody);
    assert.ok(!JSON.stringify(calls).includes("fixture-key"));
    assert.equal((await fetch(proxy.url + "/not-allowed")).status, 404);
  } finally {
    await proxy.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});

test("proxy handles non-stream JSON usage without inventing absent usage", async () => {
  const provider = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        output: [{ type: "message", text: "hello" }],
        usage: { input_tokens: 9, output_tokens: 2 },
      }),
    ),
  );
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const calls: Call[] = [];
  const proxy = await captureProxy(
    `http://127.0.0.1:${(provider.address() as any).port}`,
    calls,
    5000,
  );
  try {
    await (
      await fetch(proxy.url + "/responses", {
        method: "POST",
        body: JSON.stringify({ input: "hello" }),
      })
    ).json();
    assert.equal(calls[0].usage?.total, 11);
    assert.equal(calls[0].outputParts?.length, 1);
  } finally {
    await proxy.close();
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  }
});

test("CLI builds from Mongo with platform service, sends the turn and writes reports", async () => {
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const { MongoClient } = await import("mongodb");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { main } = await import("../scripts/profile-agent-tokens");
  const mongo = await MongoMemoryServer.create();
  const client = new MongoClient(mongo.getUri());
  const dir = await mkdtemp(join(tmpdir(), "token-profile-test-"));
  const savedArgv = process.argv;
  const savedEnv = { ...process.env };
  let config: any,
    deleted = false,
    finished = false,
    rejectThread = false;
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body);
    if (req.url?.endsWith("/chat/completions")) {
      assert.match(JSON.stringify(wire.messages), /Fixture system instruction/);
      assert.match(JSON.stringify(wire.messages), /fixture question/);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "fixture response" }, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    assert.match(wire.instructions, /Fixture system instruction/);
    assert.equal(wire.input[0].content, "fixture question");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 42, output_tokens: 8, total_tokens: 50 } } })}\n\n`,
    );
  });
  const core = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/threads") {
      if (rejectThread) {
        res.writeHead(422);
        res.end(
          JSON.stringify({
            error: "Unsupported model fixture-secret",
            code: "INVALID_MODEL",
          }),
        );
        return;
      }
      config = JSON.parse(body);
      assert.equal(config.sandbox, "read-only");
      assert.equal(config.skills[0].name, "fixture-skill");
      res.end(JSON.stringify({ threadId: "fixture-thread" }));
    } else if (req.url?.endsWith("/turns")) {
      const turn = JSON.parse(body);
      const profile = config.config[`model_providers.${config.modelProvider}`];
      await (
        await fetch(profile.base_url + "/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${profile.experimental_bearer_token}`,
          },
          body: JSON.stringify({
            instructions: config.baseInstructions,
            input: [{ role: "user", content: turn.text }],
          }),
        })
      ).text();
      finished = true;
      res.end(JSON.stringify({ turnId: "fixture-turn" }));
    } else if (req.method === "DELETE") {
      deleted = true;
      res.end("{}");
    } else {
      res.end(
        JSON.stringify({
          pending: [],
          traces: finished
            ? [
                {
                  turnId: "fixture-turn",
                  status: "completed",
                  usage: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
                },
              ]
            : [],
          messages: [
            { turnId: "fixture-turn", text: "fixture response", final: true },
          ],
        }),
      );
    }
  });
  try {
    provider.listen(0, "127.0.0.1");
    core.listen(0, "127.0.0.1");
    await Promise.all([once(provider, "listening"), once(core, "listening")]);
    await client.connect();
    const db = client.db("profile_fixture");
    await db.collection("truex_models").insertOne({
      _id: "model" as any,
      provider: "fixture",
      modelName: "fixture-model",
      apikey: "fixture-secret",
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
    });
    await db.collection("truex_skills").insertOne({
      _id: "skill" as any,
      name: "fixture-skill",
      description: "fixture",
      body: "skill body",
      version: 1,
    });
    await db.collection("truex_agents").insertOne({
      _id: "agent" as any,
      modelProfileId: "model",
      systemPrompt: "Fixture system instruction",
      skillIds: ["skill"],
    });
    process.env.MONGO_URI = mongo.getUri();
    process.env.MONGO_DB = "profile_fixture";
    process.env.CATALOG_MONGO_DB = "profile_fixture";
    process.env.APPROVAL_MODES = "off";
    const out = join(dir, "report.md");
    process.argv = [
      process.execPath,
      "profiler",
      "--agent-id",
      "agent",
      "--message",
      "fixture question",
      "--core-url",
      `http://127.0.0.1:${(core.address() as any).port}`,
      "--out",
      out,
    ];
    await main();
    const md = await readFile(out, "utf8");
    const json = await readFile(join(dir, "report.json"), "utf8");
    assert.match(md, /Input overall \| 42/);
    assert.match(md, /fixture response/);
    assert.match(md, /Skill body: fixture-skill/);
    assert.ok(!json.includes("fixture-secret"));
    assert.equal(deleted, true);
    assert.equal(await db.collection("sessions").countDocuments(), 0);
    // Document mode must succeed even with an unreachable Mongo URI.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({
        _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaaaa" },
        modelProfileId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbbb" },
        systemPrompt: "Fixture system instruction",
        skillIds: ["skill"],
      }),
    );
    await writeFile(
      join(dir, "model.json"),
      JSON.stringify({
        _id: { $oid: "bbbbbbbbbbbbbbbbbbbbbbbb" },
        provider: "fixture",
        modelName: "fixture-model",
        apikey: "fixture-secret",
        baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
        route: "gateway",
        wireApi: "chat",
      }),
    );
    await writeFile(
      join(dir, "skills.json"),
      JSON.stringify([
        {
          _id: "skill",
          name: "fixture-skill",
          description: "fixture",
          body: "skill body",
          version: 1,
        },
      ]),
    );
    process.env.MONGO_URI = "mongodb://127.0.0.1:1";
    deleted = false;
    process.argv = [
      process.execPath,
      "profiler",
      "--agent-file",
      join(dir, "agent.json"),
      "--model-file",
      join(dir, "model.json"),
      "--skills-file",
      join(dir, "skills.json"),
      "--message",
      "fixture question",
      "--core-url",
      `http://127.0.0.1:${(core.address() as any).port}`,
      "--out",
      out,
    ];
    await main();
    const documentReport = JSON.parse(
      await readFile(join(dir, "report.json"), "utf8"),
    );
    const payloads = JSON.parse(
      await readFile(join(dir, "report.payloads.json"), "utf8"),
    );
    assert.equal(payloads.turns.length, 1);
    assert.equal(payloads.turns[0].request.text, "fixture question");
    assert.deepEqual(
      JSON.parse(payloads.codexProviderRequests[0].rawRequestJson),
      payloads.codexProviderRequests[0].body,
    );
    assert.ok(!JSON.stringify(payloads).includes("fixture-secret"));
    assert.equal(documentReport.providerUsage.totals.total, 50);
    assert.equal(documentReport.turns[0].providerUsage.totals.total, 50);
    assert.equal(documentReport.inputMode, "documents");
    assert.equal(documentReport.userMessage, "fixture question");
    assert.equal(documentReport.sourceDocuments.model.apikey, "[REDACTED]");
    assert.equal(
      documentReport.platformConfiguration.baseInstructions,
      "Fixture system instruction",
    );
    assert.equal(
      documentReport.calls[0].request.instructions,
      "Fixture system instruction",
    );
    assert.equal(
      documentReport.calls[0].parts[0].data,
      "Fixture system instruction",
    );
    assert.ok(documentReport.calls[0].responseEvents.length > 0);
    assert.ok(documentReport.calls[0].responseBody);
    assert.ok(!JSON.stringify(documentReport).includes("fixture-secret"));
    assert.equal(documentReport.outcome, "completed");
    assert.equal(documentReport.calls[0].usage.total, 50);
    assert.equal(deleted, true);
    rejectThread = true;
    const previousExitCode = process.exitCode;
    try {
      await main();
      const failureReport = JSON.parse(
        await readFile(join(dir, "report.json"), "utf8"),
      );
      assert.equal(failureReport.stage, "thread-create");
      assert.equal(failureReport.failure.code, "INVALID_MODEL");
      assert.equal(failureReport.failure.status, 422);
      assert.match(failureReport.error, /Unsupported model/);
      assert.ok(!JSON.stringify(failureReport).includes("fixture-secret"));
    } finally {
      process.exitCode = previousExitCode;
    }
  } finally {
    process.argv = savedArgv;
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await client.close();
    await mongo.stop();
    provider.closeAllConnections();
    core.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => provider.close(() => r())),
      new Promise<void>((r) => core.close(() => r())),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("document Store reuses connector selection and rejects mismatched model references", async () => {
  const { documentStore, safeError } =
    await import("../scripts/token-profiler-documents");
  const { PlatformService } = await import("../src/service");
  const { Redactor } = await import("../../agent-core/src/redact");
  const agent = { _id: "a", modelProfileId: "m", systemPrompt: "prompt" };
  const model = {
    _id: "m",
    modelName: "fixture",
    provider: "fixture",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "model-secret",
  };
  assert.throws(
    () => documentStore(agent, { ...model, _id: "wrong" }),
    /must match/,
  );
  const previous = process.env.MCP_ALLOWED_PRIVATE_HOSTS;
  process.env.MCP_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
  try {
    const store = documentStore(agent, model, [
      {
        name: "tenant_connector",
        url: "http://127.0.0.1/mcp",
        apiKey: "mcp-secret",
      },
      {
        name: "owner_connector",
        scope: "user",
        ownerId: "owner",
        url: "http://127.0.0.1/mcp",
        auth: { kind: "none" },
      },
      {
        name: "other_connector",
        scope: "user",
        ownerId: "other",
        url: "http://127.0.0.1/mcp",
      },
      {
        name: "disabled_connector",
        enabled: false,
        url: "http://127.0.0.1/mcp",
      },
    ]);
    const service = new PlatformService(store);
    const config = await service.configuration("a", { ownerId: "owner" });
    assert.deepEqual(
      Object.keys(config.config).filter((k) => k.startsWith("mcp_servers.")),
      ["mcp_servers.tenant_connector", "mcp_servers.owner_connector"],
    );
    assert.match(config.baseInstructions, /tenant_connector/);
    const redactor = new Redactor();
    redactor.remember(config);
    redactor.remember({ apiKey: "mcp-secret" });
    const error = safeError(
      Object.assign(
        new Error(
          "model-secret mcp-secret failed https://user:password@host/path?token=private",
        ),
        { code: "RPC_TIMEOUT", status: 504 },
      ),
      redactor,
    );
    assert.equal(error.code, "RPC_TIMEOUT");
    assert.equal(error.status, 504);
    assert.ok(!JSON.stringify(error).includes("model-secret"));
    assert.ok(!JSON.stringify(error).includes("mcp-secret"));
    assert.ok(!JSON.stringify(error).includes("password"));
  } finally {
    if (previous === undefined) delete process.env.MCP_ALLOWED_PRIVATE_HOSTS;
    else process.env.MCP_ALLOWED_PRIVATE_HOSTS = previous;
  }
});

test("Mongo shell exports parse as data; executable expressions are rejected", async () => {
  const { parseDocumentText } =
    await import("../scripts/token-profiler-documents");
  const doc = parseDocumentText(
    `{
    _id: ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
    modelProfileId: new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'),
    name: 'SAP agent', count: NumberInt('2'),
    large: NumberLong('9007199254740993'),
    at: ISODate('2026-10-03T00:00:00Z'),
    enabled: true, optional: null, list: [-1, 'tool'],
  }`,
    "agent.json",
  );
  assert.equal(doc._id, "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(doc.count, 2);
  assert.equal(doc.large, "9007199254740993");
  assert.equal(doc.at, "2026-10-03T00:00:00.000Z");
  assert.deepEqual(doc.list, [-1, "tool"]);
  for (const text of [
    "{ _id: process.exit(1) }",
    "{ ...process.env }",
    "{ value: (() => 'x')() }",
    "{ value: NumberInt('not-an-int') }",
    "{ name: '",
  ]) {
    assert.throws(
      () => parseDocumentText(text, "agent.json"),
      /agent.json: invalid document at line/,
    );
  }
  assert.deepEqual(
    parseDocumentText('{"_id":{"$oid":"aaaaaaaaaaaaaaaaaaaaaaaa"}}'),
    { _id: "aaaaaaaaaaaaaaaaaaaaaaaa" },
  );
});

test("document credentials may reference environment variables; a missing one is an error", async () => {
  const { resolveCredentialReferences } =
    await import("../scripts/token-profiler-documents");
  const env = { PROFILE_KEY: "from-env", EMPTY_KEY: "" };
  assert.deepEqual(
    resolveCredentialReferences(
      { name: "m", apikey: "${PROFILE_KEY}", apiKey: "plain-value" },
      "model.json",
      env,
    ),
    { name: "m", apikey: "from-env", apiKey: "plain-value" },
  );
  // Only a whole-value reference counts; other fields are never rewritten.
  assert.deepEqual(
    resolveCredentialReferences(
      { systemPrompt: "${PROFILE_KEY}", apiKey: "<placeholder>" },
      "agent.json",
      env,
    ),
    { systemPrompt: "${PROFILE_KEY}", apiKey: "<placeholder>" },
  );
  for (const name of ["MISSING_KEY", "EMPTY_KEY"])
    assert.throws(
      () =>
        resolveCredentialReferences(
          { apikey: "${" + name + "}" },
          "models.json",
          env,
        ),
      new RegExp(`models.json: apikey refers to environment variable ${name}`),
    );
});

test("sequential turns reuse one thread and wait for each terminal trace before the next send", async () => {
  const { runSequentialTurns } =
    await import("../scripts/profile-agent-tokens");
  const questions = [
    "Hi bro ?",
    "Can you list down the apps in the qlik ?",
    "What is the capital of india ?",
  ];
  const calls: Call[] = [];
  const sent: string[] = [];
  let active = 0,
    waiting = false,
    polls = 0;
  const fake: any = {
    hosts: ["fixture"],
    call: async (_host: string, path: string, method?: string, body?: any) => {
      assert.ok(path.startsWith("/threads/same-thread/"));
      if (method === "POST") {
        assert.equal(
          waiting,
          false,
          "a prior turn must complete before the next message",
        );
        sent.push(body.text);
        active++;
        polls = 0;
        waiting = true;
        calls.push({
          index: calls.length + 1,
          parts: [],
          usage: {
            input: active * 10,
            cached: 0,
            output: 2,
            reasoning: 0,
            total: active * 10 + 2,
          },
        });
        return { turnId: `turn-${active}` };
      }
      polls++;
      const completed = polls === 2;
      if (completed) waiting = false;
      return {
        pending: [],
        messages: [{ turnId: `turn-${active}`, text: `answer ${active}` }],
        traces: completed
          ? [
              {
                turnId: `turn-${active}`,
                status: "completed",
                usage: {
                  inputTokens: active * 10,
                  outputTokens: 2,
                  totalTokens: active * 10 + 2,
                },
              },
            ]
          : [{ turnId: "old-turn", status: "completed" }],
      };
    },
  };
  const data: any = { threadId: "same-thread" };
  await runSequentialTurns(fake, data, questions, calls, 2000);
  assert.deepEqual(sent, questions);
  assert.equal(data.turns.length, 3);
  assert.deepEqual(
    data.turns.map((t: any) => t.response),
    ["answer 1", "answer 2", "answer 3"],
  );
  assert.deepEqual(
    calls.map((c) => c.turnIndex),
    [1, 2, 3],
  );
  assert.equal(data.runtimeUsage.inputTokens, 60);
  assert.equal(data.runtimeUsage.outputTokens, 6);
  assert.equal(data.outcome, "completed");
});

test("sequence stops after a failed turn and preserves partial call attribution", async () => {
  const { runSequentialTurns } =
    await import("../scripts/profile-agent-tokens");
  const calls: Call[] = [];
  let sent = 0;
  const fake: any = {
    hosts: ["fixture"],
    call: async (_host: string, _path: string, method?: string) => {
      if (method === "POST") {
        sent++;
        calls.push({ index: 1, parts: [], usage: null });
        return { turnId: "failed-turn" };
      }
      return {
        pending: [],
        messages: [],
        traces: [{ turnId: "failed-turn", status: "failed", usage: null }],
      };
    },
  };
  const data: any = { threadId: "one-thread" };
  await assert.rejects(
    runSequentialTurns(fake, data, ["one", "two"], calls, 1000),
    /remaining messages were not sent/,
  );
  assert.equal(sent, 1);
  assert.equal(data.turns[0].outcome, "failed");
  assert.deepEqual(data.turns[0].callIndexes, [1]);
  assert.equal(calls[0].turnId, "failed-turn");
});

test("only explicitly named MCP tool approvals are answered while a sequence runs", async () => {
  const { runSequentialTurns } =
    await import("../scripts/profile-agent-tokens");
  let approved = false;
  const question = {
    id: "mcp_tool_call_approval_fixture",
    question: 'Allow the qlik MCP server to run tool "get_apps"?',
    options: [{ label: "Allow" }],
  };
  const fake: any = {
    hosts: ["fixture"],
    call: async (_host: string, path: string, method?: string, body?: any) => {
      if (path.endsWith("/turns")) return { turnId: "t" };
      if (path.includes("/approvals/")) {
        assert.equal(method, "POST");
        assert.deepEqual(body.result.answers[question.id].answers, ["Allow"]);
        approved = true;
        return {};
      }
      return {
        messages: [],
        traces: approved ? [{ turnId: "t", status: "completed" }] : [],
        pending: approved
          ? []
          : [
              {
                requestId: "p",
                method: "item/tool/requestUserInput",
                detail: { questions: [question] },
              },
            ],
      };
    },
  };
  await runSequentialTurns(
    fake,
    { threadId: "same" },
    ["list apps"],
    [],
    1000,
    ["qlik:get_apps"],
  );
  assert.equal(approved, true);
  approved = false;
  await assert.rejects(
    runSequentialTurns(fake, { threadId: "same" }, ["list apps"], [], 1000, [
      "qlik:other",
    ]),
    /outside --allow-tool/,
  );
  assert.equal(approved, false);
});
