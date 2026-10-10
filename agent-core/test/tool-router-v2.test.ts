import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GlobalToolRegistry,
  ToolRouter,
  LexicalToolRetriever,
  createExposedBindings,
  calibrateRoutingThresholds,
  DEFAULT_ROUTING_THRESHOLDS,
  routingCalibrationTools,
  routingCalibrationExamples,
  type RegisteredTool,
  type RoutingRequest,
} from "../src/tool-router-v2";

const request = (
  query: string,
  extra: Partial<RoutingRequest> = {},
): RoutingRequest => ({
  query,
  tenantId: "fixture",
  userId: "user-1",
  ...extra,
});
function registry(tools = routingCalibrationTools): GlobalToolRegistry {
  const result = new GlobalToolRegistry();
  for (const tool of tools) result.upsert(tool);
  return result;
}
const authorizer = async () => true;
const ids = (tools: RegisteredTool[]) => tools.map((tool) => tool.id).sort();

test("labeled calibration derives reproducible defaults rather than an unmeasured confidence claim", async () => {
  const measured = calibrateRoutingThresholds();
  assert.equal(measured.correct, measured.examples);
  assert.equal(measured.unsafeDirect, 0);
  assert.equal(measured.accuracy, 1);
  assert.deepEqual(DEFAULT_ROUTING_THRESHOLDS, {
    highConfidenceThreshold: measured.highConfidenceThreshold,
    ambiguityMargin: measured.ambiguityMargin,
  });
  assert.deepEqual(calibrateRoutingThresholds(), measured);
  const router = new ToolRouter(registry(), authorizer);
  for (const example of routingCalibrationExamples) {
    const actual = await router.route(example);
    assert.equal(actual.mode, example.expectedMode, example.query);
    assert.deepEqual(
      ids(actual.selected),
      [...example.expectedToolIds].sort(),
      example.query,
    );
    assert.equal(actual.query, example.query);
    assert.ok(actual.routingLatencyMs >= 0);
  }
  assert.throws(() => calibrateRoutingThresholds([], []), /labeled/);
});

test("tenant/enabled/availability/explicit attachment filtering occurs before authorization", async () => {
  const app = routingCalibrationTools[0];
  const tools = [
    app,
    { ...app, id: "other-tenant", tenantId: "other" },
    { ...app, id: "disabled", enabled: false },
    { ...app, id: "unavailable", available: false },
    { ...app, id: "unattached", serverId: "unattached" },
  ];
  const evaluated: string[] = [];
  const router = new ToolRouter(registry(tools), async (tool) => {
    evaluated.push(tool.id);
    return true;
  });
  const plan = await router.route(
    request("List Qlik apps", { context: { allowedServerIds: ["qlik"] } }),
  );
  assert.deepEqual(evaluated, [app.id]);
  assert.deepEqual(ids(plan.selected), [app.id]);
  assert.ok(plan.candidates.every((candidate) => candidate.tool.id === app.id));
});

test("permission checks run afresh for each user/turn and authorization failures fail closed", async () => {
  let allowed = true;
  let calls = 0;
  const store = registry([routingCalibrationTools[0]]);
  const router = new ToolRouter(store, async (_tool, current) => {
    calls++;
    assert.equal(current.userId, "user-1");
    return allowed;
  });
  assert.equal(
    (await router.route(request("List Qlik apps"))).selected.length,
    1,
  );
  allowed = false;
  const denied = await router.route(request("List Qlik apps"));
  assert.equal(denied.mode, "discovery");
  assert.deepEqual(denied.candidates, []);
  assert.deepEqual(denied.authorizationRemoved, [
    routingCalibrationTools[0].id,
  ]);
  assert.equal(calls, 2);
  const failing = new ToolRouter(store, async () => {
    throw new Error("permission backend unavailable");
  });
  assert.equal(
    (await failing.route(request("List Qlik apps"))).selected.length,
    0,
  );
});

test("authorization sees clones and cannot rewrite the dispatch registry", async () => {
  const store = registry([routingCalibrationTools[0]]);
  const router = new ToolRouter(store, async (tool) => {
    tool.toolName = "write_data";
    tool.inputSchema = { type: "null" };
    return true;
  });
  const plan = await router.route(request("List Qlik apps"));
  assert.equal(plan.selected[0].toolName, "get_apps");
  assert.notEqual(store.all()[0].inputSchema.type, "null");
});

test("greetings and general knowledge exclude enterprise schemas even after Qlik context", async () => {
  const router = new ToolRouter(registry(), authorizer);
  for (const query of [
    "Hi bro ?",
    "What is the capital of India ?",
    "Hello I am Ashok what is your name",
    "What is 2 plus 2?",
  ]) {
    const plan = await router.route(
      request(query, {
        context: {
          recentServerIds: ["qlik"],
          recentToolIds: ["qlik:get_apps"],
        },
        conversationContext: "Qlik apps returned many apps. ".repeat(100),
      }),
    );
    assert.equal(plan.mode, "no_tools", query);
    assert.deepEqual(plan.selected, [], query);
  }
});

test("compact recent-tool context resolves pagination and modified-recently followups only", async () => {
  const router = new ToolRouter(registry(), authorizer);
  for (const query of [
    "Next page",
    "Show the next 50 apps",
    "Which ones were modified recently?",
  ]) {
    const contextual = await router.route(
      request(query, {
        context: {
          recentServerIds: ["qlik"],
          recentToolIds: ["qlik:get_apps"],
        },
      }),
    );
    assert.equal(contextual.mode, "direct_tools", query);
    assert.deepEqual(ids(contextual.selected), ["qlik:get_apps"], query);
    assert.match(contextual.candidates[0].reason, /compact recent-tool/);
    assert.equal((await router.route(request(query))).mode, "discovery", query);
  }
  const denied = await router.route(
    request("Next page", {
      context: {
        recentToolIds: ["qlik:get_apps"],
        recentServerIds: ["qlik"],
        allowedServerIds: ["sap"],
      },
    }),
  );
  assert.equal(denied.mode, "discovery");
  assert.deepEqual(denied.selected, []);
});

test("ambiguous equal customer tools fall back instead of choosing a connector by insertion order", async () => {
  const tools = routingCalibrationTools.filter(
    (tool) => tool.toolName === "get_customers",
  );
  for (const list of [tools, [...tools].reverse()]) {
    const router = new ToolRouter(registry(list), authorizer);
    const plan = await router.route(request("Get customers"));
    assert.equal(plan.mode, "discovery");
    assert.match(plan.fallbackReason!, /Ambiguous/);
    assert.deepEqual(plan.selected, []);
  }
});

test("Top-K spans multiple requested servers and falls back rather than silently dropping required coverage", async () => {
  const router = new ToolRouter(registry(), authorizer);
  const plan = await router.route(
    request("Compare Qlik apps and Snowflake tables"),
  );
  assert.deepEqual(ids(plan.selected), [
    "qlik:get_apps",
    "snowflake:list_tables",
  ]);
  const limited = await router.route(
    request("Compare Qlik apps and Snowflake tables", { maxTools: 1 }),
  );
  assert.equal(limited.mode, "discovery");
  assert.match(limited.fallbackReason!, /cover all/);
});

test("native docs/workspace tools are ranked alongside business tools while mandatory controls stay outside selection", async () => {
  const mandatory: RegisteredTool = {
    id: "native:update_plan",
    serverId: "native",
    toolName: "update_plan",
    sourceType: "native",
    scope: "global",
    inputSchema: { type: "object" },
    mandatory: true,
    tags: ["plan"],
  };
  const router = new ToolRouter(
    registry([...routingCalibrationTools, mandatory]),
    authorizer,
  );
  const combined = await router.route(
    request("List Qlik apps and create an Excel spreadsheet"),
  );
  assert.deepEqual(ids(combined.selected), [
    "qlik:get_apps",
    "workspace:create_spreadsheet",
  ]);
  assert.ok(
    combined.candidates.every(
      (candidate) => candidate.tool.id !== mandatory.id,
    ),
  );
  const native: RegisteredTool = {
    ...routingCalibrationTools.find(
      (tool) => tool.toolName === "create_document",
    )!,
    id: "global-document",
    tenantId: undefined,
    scope: "global",
  };
  const otherTenant = new ToolRouter(
    registry([native, routingCalibrationTools[0]]),
    authorizer,
  );
  const selected = await otherTenant.route(
    request("Create a Word document", { tenantId: "other" }),
  );
  assert.deepEqual(ids(selected.selected), ["global-document"]);
});

test("registry normalization whitelists metadata and clones schemas rather than retaining credentials", () => {
  const raw = {
    ...structuredClone(routingCalibrationTools[0]),
    enabled: undefined,
    available: undefined,
    serverName: "Qlik",
    readOnly: true,
    destructive: false,
    requiresApproval: true,
    http_headers: { authorization: "private-value" },
    apiKey: "private-value",
  };
  const store = registry([raw]);
  raw.inputSchema.properties = { changed: true };
  const normalized = store.all()[0];
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.available, true);
  assert.equal(normalized.readOnly, true);
  assert.equal(normalized.requiresApproval, true);
  assert.equal(normalized.name, normalized.toolName);
  assert.ok(!JSON.stringify(normalized).includes("private-value"));
  assert.notDeepEqual(normalized.inputSchema.properties, { changed: true });
  normalized.tags?.push("tampered");
  assert.ok(!store.all()[0].tags?.includes("tampered"));
});

test("registry rejects unsafe scope, conflicting aliases and reassigned identity", () => {
  const store = registry([routingCalibrationTools[0]]);
  assert.throws(
    () => store.upsert({ ...routingCalibrationTools[0], tenantId: undefined }),
    /tenantId/,
  );
  assert.throws(
    () => store.upsert({ ...routingCalibrationTools[0], scope: "global" }),
    /native/,
  );
  assert.throws(
    () => store.upsert({ ...routingCalibrationTools[0], name: "wrong" }),
    /aliases/,
  );
  assert.throws(
    () => store.upsert({ ...routingCalibrationTools[0], serverId: "other" }),
    /reassigned/,
  );
  assert.throws(
    () => store.upsert({ ...routingCalibrationTools[0], toolName: 5 } as any),
    /metadata/,
  );
});

test("scoped replacement/invalidation is atomic, changes revision and routes only current metadata", async () => {
  const first = routingCalibrationTools[0];
  const store = registry([first, { ...first, tenantId: "other" }]);
  const originalRevision = store.revision;
  assert.throws(
    () =>
      store.replaceServer("qlik", [{ ...first, serverId: "wrong" }], "fixture"),
    /scope/,
  );
  assert.equal(store.revision, originalRevision);
  assert.equal(store.all().length, 2);
  store.replaceServer(
    "qlik",
    [{ ...first, enabled: false, configVersion: "v2" }],
    "fixture",
  );
  assert.ok(store.revision > originalRevision);
  assert.equal(
    store.all().find((tool) => tool.tenantId === "other")!.enabled,
    true,
  );
  assert.equal(
    (await new ToolRouter(store, authorizer).route(request("List Qlik apps")))
      .selected.length,
    0,
  );
  store.invalidate("qlik", "fixture");
  assert.deepEqual(
    store.all().map((tool) => tool.tenantId),
    ["other"],
  );
  store.invalidate();
  assert.deepEqual(store.all(), []);
});

test("same tool IDs in different tenants remain separate permission-scoped registrations", async () => {
  const first = routingCalibrationTools[0];
  const store = registry([
    first,
    { ...first, tenantId: "other", description: "Other tenant apps" },
  ]);
  assert.equal(store.all().length, 2);
  const router = new ToolRouter(store, authorizer);
  const selected = await router.route(
    request("List Qlik apps", { tenantId: "other" }),
  );
  assert.equal(selected.selected[0].tenantId, "other");
  assert.equal(selected.selected[0].description, "Other tenant apps");
});

test("unique exposed names remain simple; collisions are deterministic and preserve native dispatch", () => {
  const qlik = routingCalibrationTools[0];
  assert.equal(createExposedBindings([qlik])[0].bindingName, "get_apps");
  const second = { ...qlik, id: "second", serverId: "other" };
  const forward = createExposedBindings([qlik, second]);
  const backward = createExposedBindings([second, qlik]);
  assert.equal(new Set(forward.map((tool) => tool.bindingName)).size, 2);
  assert.deepEqual(
    forward.map((tool) => [tool.id, tool.bindingName]).sort(),
    backward.map((tool) => [tool.id, tool.bindingName]).sort(),
  );
  assert.equal(forward[0].bindingName, "qlik__get_apps");
  assert.notEqual(
    createExposedBindings([qlik], ["get_apps"])[0].bindingName,
    "get_apps",
  );
  assert.equal(
    createExposedBindings([{ ...qlik, bindingName: "pinned_binding" }])[0]
      .bindingName,
    "pinned_binding",
  );
  assert.throws(
    () =>
      createExposedBindings(
        [{ ...qlik, bindingName: "pinned_binding" }],
        ["pinned_binding"],
      ),
    /collision/,
  );
  const collidingServer = { ...second, serverId: "q.lik" };
  const alternateServer = { ...qlik, serverId: "q lik" };
  const safe = createExposedBindings([collidingServer, alternateServer]);
  assert.equal(new Set(safe.map((tool) => tool.bindingName)).size, 2);
  assert.ok(safe.every((tool) => tool.bindingName!.length <= 64));
});

test("injected retrievers cannot expose unauthorized schemas or override trusted schema contents", async () => {
  const qlik = routingCalibrationTools[0];
  const intruder = {
    ...qlik,
    id: "intruder",
    tenantId: "other",
    bindingName: "write_secret",
  };
  const router = new ToolRouter(registry([qlik]), authorizer, {
    retriever: {
      retrieve: () => [
        { tool: intruder, score: 1, reason: "injected" },
        {
          tool: { ...qlik, inputSchema: { type: "null" } },
          score: 1,
          reason: "valid identity, tampered schema",
        },
      ],
    },
  });
  const plan = await router.route(request("List Qlik apps"));
  assert.deepEqual(ids(plan.selected), [qlik.id]);
  assert.equal(plan.selected[0].inputSchema.type, "object");
});

test("BM25/tag/exact-name retrieval explains scores and accepts controlled threshold overrides", async () => {
  const retriever = new LexicalToolRetriever();
  const candidates = retriever.retrieve(
    request("get_apps in Qlik"),
    routingCalibrationTools,
  );
  assert.equal(candidates[0].tool.id, "qlik:get_apps");
  assert.match(candidates[0].reason, /BM25=.*exact tool phrase/);
  const custom = new ToolRouter(registry(), authorizer, {
    highConfidenceThreshold: 0.99,
    ambiguityMargin: 0.2,
    topK: 1,
  });
  assert.equal(
    (await custom.route(request("Create a Word document"))).mode,
    "discovery",
  );
  for (const options of [
    { highConfidenceThreshold: NaN },
    { ambiguityMargin: -1 },
    { topK: 17 },
  ])
    assert.throws(() => new ToolRouter(registry(), authorizer, options));
  await assert.rejects(
    custom.route(request("Qlik apps", { maxTools: 0 })),
    /maxTools/,
  );
  await assert.rejects(
    custom.route(request("Qlik apps", { tenantId: "" })),
    /tenantId/,
  );
});

test("descriptor token index is bounded, reused and invalidated by metadata/config revision without caching authorization", async () => {
  const retriever = new LexicalToolRetriever();
  const store = registry([routingCalibrationTools[0]]);
  let authorized = true;
  let checks = 0;
  const router = new ToolRouter(
    store,
    async () => {
      checks++;
      return authorized;
    },
    { retriever },
  );
  await router.route(request("List Qlik apps"));
  const first = retriever.indexStats;
  await router.route(request("List Qlik apps"));
  assert.equal(checks, 2);
  assert.ok(retriever.indexStats.hits > first.hits);
  store.upsert({
    ...routingCalibrationTools[0],
    configVersion: "changed",
    tags: ["apps", "changed"],
  });
  await router.route(request("List Qlik apps"));
  assert.ok(retriever.indexStats.misses > first.misses);
  authorized = false;
  assert.deepEqual(
    (await router.route(request("List Qlik apps"))).selected,
    [],
  );
  assert.equal(checks, 4);
  retriever.retrieve(
    request("apps"),
    Array.from({ length: 600 }, (_, i) => ({
      ...routingCalibrationTools[0],
      id: `bounded-${i}`,
    })),
  );
  assert.equal(retriever.indexStats.size, 512);
  retriever.invalidate();
  assert.equal(retriever.indexStats.size, 0);
});

test("metadata/config changes during asynchronous authorization invalidate the in-flight route", async () => {
  const store = registry([routingCalibrationTools[0]]);
  const router = new ToolRouter(store, async () => {
    store.invalidate("qlik", "fixture");
    return true;
  });
  const route = await router.route(request("List Qlik apps"));
  assert.equal(route.mode, "discovery");
  assert.deepEqual(route.selected, []);
  assert.deepEqual(route.candidates, []);
  assert.match(route.fallbackReason!, /changed during authorization/);
});

// Descriptor text copied from the healthy 14-tool Qlik capture. Routing uses
// descriptor semantics, not synthetic labels or projection parameter schemas.
const actualQlikDescriptors: { toolName: string; description: string }[] = [
  {
    toolName: "engine_get_visualization_data",
    description:
      "Get actual data from a visualization object (chart, KPI, table, filter pane, etc.). Returns dimension values, measure values, and complete data structure with the actual data displayed in the visualization.",
  },
  {
    toolName: "get_app_details",
    description:
      "Get compact application info with filters by guid or name (case-insensitive). Returns metainfo, tables/fields list, master items, sheets and objects with used fields. You must provide at least one of app_id or name.",
  },
  {
    toolName: "get_app_field_statistics",
    description: "Get comprehensive statistics for a field",
  },
  {
    toolName: "get_app_field",
    description:
      "Return values of a single field from app with pagination and wildcard search (supports * and %).",
  },
  {
    toolName: "get_app_object",
    description:
      "Get specific object layout by calling GetObject and GetLayout sequentially via WebSocket.",
  },
  {
    toolName: "get_app_script",
    description: "Get load script from app",
  },
  {
    toolName: "get_app_sheet_objects",
    description:
      "Get list of objects from specific sheet with object ID, type and description.",
  },
  {
    toolName: "get_app_sheets",
    description:
      "Get list of sheets from application with title and description.",
  },
  {
    toolName: "get_app_variables",
    description:
      "Return variables split by source (script/ui) with pagination and wildcard search.",
  },
  {
    toolName: "get_apps",
    description:
      "Get list of Qlik Sense applications with essential fields and filters (name, stream, published) and pagination.",
  },
  {
    toolName: "get_connections",
    description:
      "Get the data connection for a specific lib:// path in a Qlik Sense app via the Engine API (GetConnections). Strips the 'lib://' prefix, extracts the first path segment (the connection name), calls GetConnections on the document handle, and returns the single connection object whose qName matches that segment. Example: lib_path='lib://30_AUTO_Quality\\30_Automotive\\file.qvd' → looks up connection with qName='30_AUTO_Quality'.",
  },
  {
    toolName: "get_lineage",
    description:
      "Get complete data lineage for a Qlik Sense app. Returns the origin and flow of data including LOAD/STORE statements, external connectors, file sources, inline data, resident tables, and auto-generated data. Each lineage entry shows the discriminator (data origin type), the script statement, and the source path.",
  },
  {
    toolName: "get_qvd_app_id",
    description:
      "Extract the creator application ID from a QVD file by reading the CreatorDoc tag from the file header. This tool reads the QVD file directly from the filesystem and does not require Qlik Sense API access.",
  },
  {
    toolName: "get_upstream_lineage",
    description:
      "Fetch the load script of a Qlik Sense app and identify all upstream data dependencies using AWS Bedrock AI. Returns a textual report listing all upstream QVD file dependencies and Snowflake table dependencies found in the app's load script.",
  },
];
const actualQlikTools = (serverId = "qlik"): RegisteredTool[] =>
  actualQlikDescriptors.map((descriptor) => ({
    ...descriptor,
    id: JSON.stringify([serverId, descriptor.toolName]),
    serverId,
    vendor: "qlik",
    tenantId: "fixture",
    sourceType: "mcp",
    scope: "tenant",
    bindingName: `${serverId}__${descriptor.toolName}`,
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
    requiresApproval: true,
  }));
const explanationNames = [
  "get_apps",
  "get_app_details",
  "get_app_script",
  "get_lineage",
  "get_app_sheets",
];

test("actual Qlik catalog covers the exact five-turn task sequence without blanket exposure", async () => {
  const router = new ToolRouter(registry(actualQlikTools()), authorizer);
  const context = {
    registryState: "ready" as const,
    allowedServerIds: ["qlik"],
    activeServerId: "qlik",
    recentServerIds: ["qlik"],
    recentToolIds: [JSON.stringify(["qlik", "get_apps"])],
  };
  const queries = [
    "hi this is ashok ?",
    "What is the capital of India ?",
    "what are the Qlik apps ?",
    "What is the capital of tamilnadu ?",
    "Explain this qlik app T_DCF_BANKREC_P",
  ];
  const expected = [[], [], ["get_apps"], [], explanationNames];
  for (let index = 0; index < queries.length; index++) {
    const plan = await router.route(request(queries[index], { context }));
    assert.equal(
      plan.mode,
      expected[index].length ? "direct_tools" : "no_tools",
    );
    assert.deepEqual(
      plan.selected.map((tool) => tool.toolName),
      expected[index],
    );
    assert.deepEqual(
      plan.exposedBindings,
      expected[index].map((name) => `qlik__${name}`),
    );
    assert.deepEqual(plan.thresholds, DEFAULT_ROUTING_THRESHOLDS);
    assert.ok(plan.thresholds!.highConfidenceThreshold >= 0.85);
    assert.equal(plan.retrievalIndex?.toolCount, 14);
    assert.ok(plan.retrievalIndex!.durationMs >= 0);
    if (index === 4) {
      assert.equal(plan.task?.kind, "app_explanation");
      assert.deepEqual(plan.task?.missingTools, []);
      assert.ok(
        plan.selected.every(
          (tool) => tool.readOnly === false && tool.requiresApproval === true,
        ),
      );
      assert.ok(
        !plan.candidates
          .find((candidate) => candidate.tool.toolName === "get_apps")
          ?.reason.includes("exact tool phrase"),
      );
    }
  }
});

test("app explanation preserves lookup and complementary coverage instead of depending on lexical Top-K", async () => {
  const router = new ToolRouter(registry(actualQlikTools()), authorizer);
  const activeEntities = [
    {
      kind: "app",
      serverId: "qlik",
      guid: "id-1",
      name: "T_DCF_BANKREC_P",
      stream: "QVD Generator",
    },
    {
      kind: "app",
      serverId: "qlik",
      guid: "id-2",
      name: "T_DCF_BANKREC_P",
      stream: "Test",
    },
  ];
  const original = structuredClone(activeEntities);
  for (const query of [
    "Explain this app",
    "Describe T_DCF_BANKREC_P application",
    "Explain this qlik app T_DCF_BANKREC_P and its load script and lineage",
  ]) {
    const plan = await router.route(
      request(query, {
        context: {
          activeServerId: "qlik",
          activeEntities,
          allowedServerIds: ["qlik"],
        },
      }),
    );
    assert.equal(plan.mode, "direct_tools", query);
    assert.deepEqual(
      plan.selected.map((tool) => tool.toolName),
      explanationNames,
    );
  }
  assert.deepEqual(
    activeEntities,
    original,
    "routing must not collapse two same-name app identities or choose a GUID",
  );
  const limited = await router.route(
    request("Explain this qlik app T_DCF_BANKREC_P", { maxTools: 4 }),
  );
  assert.equal(limited.mode, "discovery");
  assert.equal(limited.fallbackCode, "task_budget_exceeded");
  assert.deepEqual(limited.selected, []);
});

test("explanation expansion checks current availability and fresh permissions for every capability", async () => {
  for (const state of ["disabled", "unavailable", "denied"] as const) {
    const tools = actualQlikTools().map((tool) =>
      tool.toolName === "get_app_script"
        ? {
            ...tool,
            enabled: state !== "disabled",
            available: state !== "unavailable",
          }
        : tool,
    );
    let allowed = true;
    const router = new ToolRouter(
      registry(tools),
      async (tool) =>
        allowed && !(state === "denied" && tool.toolName === "get_app_script"),
    );
    const plan = await router.route(
      request("Explain this qlik app T_DCF_BANKREC_P"),
    );
    assert.equal(plan.mode, "discovery", state);
    assert.equal(plan.fallbackCode, "missing_task_coverage");
    assert.deepEqual(plan.task?.missingTools, ["get_app_script"]);
    assert.deepEqual(plan.selected, []);
    assert.ok(
      !plan.candidates.some(
        (candidate) => candidate.tool.toolName === "get_app_script",
      ),
    );
    allowed = false;
    const next = await router.route(
      request("Explain this qlik app T_DCF_BANKREC_P"),
    );
    assert.deepEqual(next.task?.missingTools, explanationNames);
    assert.deepEqual(next.candidates, []);
  }
});

test("registry unavailability is explicit for affected business queries while unrelated turns need no tools", async () => {
  const router = new ToolRouter(registry([]), authorizer);
  for (const registryState of ["initializing", "failed", "degraded"] as const) {
    const context = {
      registryState,
      allowedServerIds: ["qlik"],
      unavailableServerIds: ["qlik"],
      activeServerId: "qlik",
    };
    for (const query of [
      "what are the Qlik apps ?",
      "Explain this qlik app T_DCF_BANKREC_P",
      "Explain this app",
      "Show the next page",
    ]) {
      const plan = await router.route(request(query, { context }));
      assert.equal(plan.mode, "discovery");
      assert.equal(plan.fallbackCode, "registry_unavailable");
      assert.deepEqual(plan.selected, []);
      assert.deepEqual(plan.exposedBindings, [
        "discover_server",
        "discover_tools",
        "get_tool_schema",
        "invoke_tool",
      ]);
    }
    for (const query of [
      "hi this is ashok ?",
      "What is the capital of India ?",
      "What is the capital of tamilnadu ?",
    ]) {
      const plan = await router.route(request(query, { context }));
      assert.equal(plan.mode, "no_tools");
      assert.equal(plan.fallbackCode, undefined);
    }
  }
});

test("partly degraded catalogs route healthy servers and never substitute them for an unavailable server", async () => {
  const evaluated: string[] = [];
  const router = new ToolRouter(
    registry([
      ...actualQlikTools(),
      ...routingCalibrationTools.filter((tool) => tool.serverId === "sap"),
    ]),
    async (tool) => {
      evaluated.push(tool.serverId);
      return true;
    },
  );
  const context = {
    registryState: "degraded" as const,
    allowedServerIds: ["qlik", "sap"],
    unavailableServerIds: ["qlik"],
  };
  const healthy = await router.route(
    request("Retrieve invoices from SAP", { context }),
  );
  assert.equal(healthy.mode, "direct_tools");
  assert.deepEqual(
    healthy.selected.map((tool) => tool.toolName),
    ["get_invoices"],
  );
  assert.ok(evaluated.every((server) => server === "sap"));
  const unavailable = await router.route(
    request("what are the Qlik apps ?", { context }),
  );
  assert.equal(unavailable.fallbackCode, "registry_unavailable");
  assert.deepEqual(unavailable.selected, []);
  const wrong = await router.route(
    request("Explain this Salesforce app", { context }),
  );
  assert.equal(wrong.fallbackCode, undefined);
  assert.deepEqual(wrong.selected, []);
});

test("explanation context disambiguates a followup but does not silently choose between explicit same-vendor servers", async () => {
  const router = new ToolRouter(
    registry([
      ...actualQlikTools("qlik_prod"),
      ...actualQlikTools("qlik_test"),
    ]),
    authorizer,
  );
  const ambiguous = await router.route(request("Explain this Qlik app"));
  assert.equal(ambiguous.mode, "discovery");
  assert.equal(ambiguous.fallbackCode, "ambiguous_task_server");
  const contextual = await router.route(
    request("Explain this app", { context: { activeServerId: "qlik_prod" } }),
  );
  assert.equal(contextual.mode, "direct_tools");
  assert.ok(contextual.selected.every((tool) => tool.serverId === "qlik_prod"));
  const wrongVendor = await router.route(
    request("Explain this Salesforce app", {
      context: { activeServerId: "qlik_prod" },
    }),
  );
  assert.deepEqual(wrongVendor.selected, []);
});

test("known or bounded app identifier followups survive an intervening general question", async () => {
  const router = new ToolRouter(registry(actualQlikTools()), authorizer);
  const context = {
    activeServerId: "qlik",
    allowedServerIds: ["qlik"],
    activeEntities: [
      {
        kind: "app",
        serverId: "qlik",
        name: "T_DCF_BANKREC_P",
        guid: "a3cf67e1-8c4e-4ef5-b016-8f173e1e9ec9",
      },
    ],
  };
  assert.equal(
    (
      await router.route(
        request("What is the capital of tamilnadu ?", { context }),
      )
    ).mode,
    "no_tools",
  );
  for (const query of [
    "Explain T_DCF_BANKREC_P",
    "Explain a3cf67e1-8c4e-4ef5-b016-8f173e1e9ec9",
    "Explain T_OTHER_UNSEEN_APP",
  ]) {
    const plan = await router.route(request(query, { context }));
    assert.equal(plan.mode, "direct_tools", query);
    assert.deepEqual(
      plan.selected.map((tool) => tool.toolName),
      explanationNames,
    );
    const unavailable = await router.route(
      request(query, {
        context: {
          ...context,
          registryState: "failed",
          unavailableServerIds: ["qlik"],
        },
      }),
    );
    assert.equal(unavailable.fallbackCode, "registry_unavailable");
  }
  const different = await router.route(
    request("Explain SAP T_OTHER_UNSEEN_APP", { context }),
  );
  assert.deepEqual(different.selected, []);
  const generic = await router.route(
    request("Explain photosynthesis", { context }),
  );
  assert.equal(generic.mode, "no_tools");
  const noContext = await router.route(request("Explain T_OTHER_UNSEEN_APP"));
  assert.equal(noContext.mode, "no_tools");
});

test("explanation routing does not silently omit an additional MCP or document task", async () => {
  const router = new ToolRouter(
    registry([
      ...actualQlikTools(),
      ...routingCalibrationTools.filter((tool) => tool.serverId !== "qlik"),
    ]),
    authorizer,
  );
  for (const query of [
    "Explain this Qlik app and retrieve SAP invoices",
    "Explain this Qlik app and create a Word document",
  ]) {
    const plan = await router.route(request(query));
    assert.equal(plan.mode, "discovery");
    assert.equal(plan.fallbackCode, "missing_task_coverage");
    assert.deepEqual(plan.selected, []);
  }
});

test("task-query expansion records observed anchor scores and obeys strict or low-confidence retrievers", async () => {
  const store = registry(actualQlikTools());
  const seen: string[] = [];
  const retriever = {
    retrieve: (current: RoutingRequest, tools: RegisteredTool[]) => {
      seen.push(current.query);
      return tools.map((tool) => ({
        tool,
        score: tool.toolName === "get_app_details" ? 0.9 : 0.2,
        reason: "controlled retriever score",
      }));
    },
  };
  const strict = new ToolRouter(store, authorizer, {
    retriever,
    highConfidenceThreshold: 0.95,
  });
  const query = "Explain this qlik app T_DCF_BANKREC_P";
  const denied = await strict.route(request(query));
  assert.equal(denied.mode, "discovery");
  assert.equal(denied.fallbackCode, "task_confidence_below_threshold");
  assert.equal(denied.confidence, 0.9);
  assert.equal(denied.taskRetrieval?.originalAnchorScore, 0.9);
  assert.equal(denied.taskRetrieval?.expandedAnchorScore, 0.9);
  assert.deepEqual(denied.selected, []);
  assert.deepEqual(seen, [query, `${query} qlik app details`]);
  const equalThreshold = new ToolRouter(store, authorizer, {
    retriever,
    highConfidenceThreshold: 0.9,
  });
  const eligible = await equalThreshold.route(request(query));
  assert.equal(eligible.mode, "direct_tools");
  assert.equal(eligible.confidence, 0.9);
  assert.deepEqual(
    eligible.selected.map((tool) => tool.toolName),
    explanationNames,
  );
  const low = new ToolRouter(store, authorizer, {
    retriever: {
      retrieve: (_current, tools) =>
        tools.map((tool) => ({ tool, score: 0.1, reason: "low confidence" })),
    },
  });
  const lowPlan = await low.route(request(query));
  assert.equal(lowPlan.mode, "discovery");
  assert.equal(lowPlan.confidence, 0.1);
  assert.equal(lowPlan.fallbackCode, "task_confidence_below_threshold");
});

test("canonical application entities support a plain named followup without inventing an app noun", async () => {
  const router = new ToolRouter(registry(actualQlikTools()), authorizer);
  const context = {
    activeServerId: "qlik",
    activeEntities: [
      {
        kind: "application",
        serverId: "qlik",
        name: "Bankrec",
        guid: "id-bankrec",
      },
      {
        kind: "application",
        serverId: "qlik",
        name: "Bankrec",
        guid: "id-bankrec-test",
      },
    ],
  };
  const plan = await router.route(request("Explain Bankrec", { context }));
  assert.equal(plan.mode, "direct_tools");
  assert.deepEqual(
    plan.selected.map((tool) => tool.toolName),
    explanationNames,
  );
  assert.ok(plan.taskRetrieval);
  assert.equal(plan.confidence, plan.taskRetrieval.expandedAnchorScore);
  assert.ok(plan.confidence >= plan.thresholds!.highConfidenceThreshold);
  assert.equal(plan.retrievalIndex?.queryCount, 2);
  const customer = await router.route(
    request("Explain Bankrec", {
      context: {
        ...context,
        activeEntities: [
          { kind: "customer", serverId: "qlik", name: "Bankrec" },
        ],
      },
    }),
  );
  assert.equal(customer.mode, "no_tools");
});

test("narrow field and script requests do not receive an app-explanation bundle", async () => {
  const router = new ToolRouter(registry(actualQlikTools()), authorizer);
  for (const query of [
    "Run get_app_script in Qlik",
    "Run get_app_field_statistics in Qlik",
    "Run engine_get_visualization_data in Qlik",
  ]) {
    const plan = await router.route(request(query));
    assert.equal(plan.task, undefined);
    assert.equal(plan.mode, "direct_tools", query);
    assert.equal(plan.selected.length, 1);
    assert.ok(plan.candidates[0].reason.includes("exact tool phrase"));
  }
});

test("a vendor word inside a remembered Qlik app title does not override its known server", async () => {
  const router = new ToolRouter(
    registry([
      ...actualQlikTools(),
      ...routingCalibrationTools.filter((tool) => tool.serverId === "sap"),
    ]),
    authorizer,
  );
  const context = {
    activeServerId: "qlik",
    activeEntities: [
      {
        kind: "application",
        serverId: "qlik",
        name: "SAP Data Replication Tasks",
        guid: "id-sap-qlik",
      },
    ],
  };
  const named = await router.route(
    request("Explain SAP Data Replication Tasks", { context }),
  );
  assert.equal(named.mode, "direct_tools");
  assert.ok(named.selected.every((tool) => tool.serverId === "qlik"));
  const explicit = await router.route(
    request("Explain SAP Data Replication Tasks in SAP", { context }),
  );
  assert.deepEqual(explicit.selected, []);
  const unavailable = await router.route(
    request("Explain SAP Data Replication Tasks", {
      context: {
        ...context,
        registryState: "failed",
        unavailableServerIds: ["qlik"],
      },
    }),
  );
  assert.equal(unavailable.fallbackCode, "registry_unavailable");
});
