import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { PlatformService } from "../src/service";
import { Store } from "../src/store";
import type {
  AgentDocument,
  McpDocument,
  ModelDocument,
} from "../src/documents";
import { mcpNetwork } from "../src/mcp";
import { encryptSecret } from "../src/secrets";
import "./fixtures";

const model: ModelDocument = {
  _id: "model",
  provider: "fixture",
  baseUrl: "https://model.example/v1",
  modelName: "fixture-model",
  apiKey: "fixture-key",
  wireApi: "responses",
  reasoningEffort: "low",
};
const agent: AgentDocument = {
  _id: "agent",
  name: "Agent",
  modelProfileId: "model",
  skillIds: ["second", "first"],
};
const catalogSkills = ["first", "second"].map((name) => ({
  _id: name,
  name,
  description: `${name} description`,
  body: `${name} body`,
  version: 1,
}));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
function fixture(
  options: {
    agent?: AgentDocument | null;
    model?: ModelDocument | null;
    tenant?: McpDocument[];
    owner?: McpDocument[];
    reserved?: string[];
    skills?: typeof catalogSkills;
    beforeRead?: (kind: string) => Promise<void>;
  } = {},
) {
  const reads: string[] = [];
  async function read<T>(kind: string, value: T) {
    reads.push(kind);
    await options.beforeRead?.(kind);
    return value;
  }
  const store = {
    findAgent: () => read("agent", "agent" in options ? options.agent : agent),
    findModel: () => read("model", "model" in options ? options.model : model),
    findSkills: () => read("skills", options.skills ?? catalogSkills),
    mcp: {
      find(filter: Record<string, unknown>) {
        const reserved = filter.agentIds === undefined;
        const kind = reserved ? "reserved" : String(filter.scope);
        if (!reserved) {
          assert.equal(filter.agentIds, "agent");
          assert.deepEqual(filter.enabled, { $ne: false });
          if (filter.scope === "user") assert.equal(filter.ownerId, "owner");
        }
        const rows = reserved
          ? (
              options.reserved ??
              options.tenant?.map((mcp) => mcp.name) ??
              []
            ).map((name) => ({ name }))
          : filter.scope === "tenant"
            ? (options.tenant ?? [])
            : (options.owner ?? []);
        return {
          sort(order: Record<string, number>) {
            assert.deepEqual(order, { name: 1 });
            return this;
          },
          toArray: () => read(kind, rows),
        };
      },
    },
  } as unknown as Store;
  return { service: new PlatformService(store), reads };
}
const connector = (name: string, scope: "tenant" | "user" = "tenant") =>
  ({
    _id: `${scope}-${name}`,
    name,
    scope,
    transport: "http",
    url: `https://config.example/${name}`,
    auth: { kind: "none" },
  }) satisfies McpDocument;

test("configuration starts independent reads together after the agent gate", async () => {
  const pendingAgent = gate();
  const pending = gate();
  const { service, reads } = fixture({
    beforeRead: async (kind) => {
      await (kind === "agent" ? pendingAgent.promise : pending.promise);
    },
  });
  const building = service.configuration("agent", { ownerId: "owner" });
  try {
    await setImmediate();
    assert.deepEqual([...reads], ["agent"]);
    pendingAgent.release();
    await setImmediate();
    assert.deepEqual(
      [...reads],
      ["agent", "model", "tenant", "user", "skills"],
    );
  } finally {
    pendingAgent.release();
    pending.release();
    await building;
  }
});

test("missing agent starts no configuration reads", async () => {
  const { service, reads } = fixture({ agent: null });
  await assert.rejects(service.configuration("agent"), {
    code: "AGENT_NOT_FOUND",
  });
  assert.deepEqual(reads, ["agent"]);
});

test("missing model fails before slow reads finish and later failures are observed", async () => {
  const pending = gate();
  const { service } = fixture({
    model: null,
    beforeRead: async (kind) => {
      if (!["agent", "model"].includes(kind)) {
        await pending.promise;
        throw new Error(`${kind} unavailable`);
      }
    },
  });
  const result = service
    .configuration("agent", { ownerId: "owner" })
    .catch((error: unknown) => error);
  try {
    const observed: any = await Promise.race([result, setImmediate("pending")]);
    assert.equal(observed.code, "MODEL_CONFIGURATION");
  } finally {
    pending.release();
    await result;
    await setImmediate();
  }
});

test("concurrent read failures retain the existing validation precedence", async (t) => {
  for (const failures of [
    ["model", "tenant", "user", "skills"],
    ["tenant", "user", "skills"],
    ["user", "skills"],
    ["skills"],
  ]) {
    await t.test(failures.join(","), async () => {
      const errors = new Map(failures.map((kind) => [kind, new Error(kind)]));
      const { service } = fixture({
        beforeRead: async (kind) => {
          if (errors.has(kind)) throw errors.get(kind);
        },
      });
      await assert.rejects(
        service.configuration("agent", { ownerId: "owner" }),
        (error) => error === errors.get(failures[0]),
      );
      await setImmediate();
    });
  }
});

test("tenant names win including unattached reservations; skill order and decrypted config are preserved", async () => {
  const lookup = mcpNetwork.lookup;
  mcpNetwork.lookup = async () => ["203.0.113.12"];
  try {
    const tenant: McpDocument = connector("shared");
    tenant.auth = { kind: "header", headerName: "x-api-key" };
    tenant.apiKeyEnc = encryptSecret("tenant-secret");
    const { service, reads } = fixture({
      tenant: [tenant],
      // Shadowed rows deliberately contain invalid URLs: they must be skipped.
      owner: [
        connector("own", "user"),
        { ...connector("reserved", "user"), url: "https://10.0.0.1/mcp" },
        { ...connector("shared", "user"), url: "https://10.0.0.1/mcp" },
      ],
      reserved: ["reserved", "shared"],
    });
    const config = await service.configuration("agent", {
      ownerId: "owner",
      cwd: "/fixture-workspace",
    });
    assert.deepEqual(config.config, {
      web_search: "live",
      "model_providers.profile_model": {
        name: "fixture",
        base_url: "https://model.example/v1",
        wire_api: "responses",
        experimental_bearer_token: "fixture-key",
      },
      model_reasoning_effort: "low",
      "mcp_servers.shared": {
        url: "https://config.example/shared",
        http_headers: { "x-api-key": "tenant-secret" },
      },
      "mcp_servers.own": { url: "https://config.example/own" },
    });
    assert.deepEqual(
      config.skills?.map((skill) => skill.name),
      ["second", "first"],
    );
    assert.match(config.baseInstructions, /\["shared","own"\]/);
    assert.equal(config.cwd, "/fixture-workspace");
    assert.equal(config.tenantId, "default");
    assert.ok(reads.includes("reserved"));
    assert.equal(typeof config.mcpFingerprint, "string");
  } finally {
    mcpNetwork.lookup = lookup;
  }
});

test("each build checks DNS again, rejects private answers, and retains DNS-outage behavior", async () => {
  const lookup = mcpNetwork.lookup;
  let addresses = ["203.0.113.12"];
  let calls = 0;
  mcpNetwork.lookup = async () => {
    calls++;
    return addresses;
  };
  try {
    const { service, reads } = fixture({ tenant: [connector("sap")] });
    await service.configuration("agent");
    addresses = ["203.0.113.12", "10.0.0.1"];
    await assert.rejects(
      service.configuration("agent"),
      /private network address/,
    );
    addresses = [];
    await service.configuration("agent");
    assert.equal(calls, 3);
    assert.ok(!reads.includes("user"));
    assert.ok(!reads.includes("reserved"));
  } finally {
    mcpNetwork.lookup = lookup;
  }
});

test("connector validation precedes missing skills; missing skills still fail closed", async () => {
  const { service } = fixture({
    tenant: [{ ...connector("bad"), url: "https://10.0.0.1/mcp" }],
    skills: [],
  });
  await assert.rejects(
    service.configuration("agent"),
    /private network address/,
  );
  const missing = fixture({ skills: [] });
  await assert.rejects(missing.service.configuration("agent"), {
    code: "SKILL_CONFIGURATION",
    message: "Skill missing: second",
  });
});

test("duplicate tenant names and reserved-name read failures still fail closed", async () => {
  const duplicate = fixture({ tenant: [connector("sap"), connector("sap")] });
  await assert.rejects(duplicate.service.configuration("agent"), {
    code: "CONNECTOR_CONFIGURATION",
    message: "Duplicate MCP server name: sap",
  });
  const unavailable = new Error("reserved-name query unavailable");
  const reserved = fixture({
    owner: [connector("own", "user")],
    skills: [],
    beforeRead: async (kind) => {
      if (kind === "reserved") throw unavailable;
    },
  });
  await assert.rejects(
    reserved.service.configuration("agent", { ownerId: "owner" }),
    (error) => error === unavailable,
  );
});
