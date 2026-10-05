import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../src/client";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";

function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), "model-identity-"));
  const sent: { method: string; params: any }[] = [];
  let failUpdate = false;
  let failResume = false;
  let resolvedModel: string | undefined;
  let onResume: ((client: CodexClient) => any) | undefined;
  const original = CodexClient.prototype.request;
  CodexClient.prototype.request = async function (method: string, params: any) {
    sent.push({ method, params });
    if (method === "thread/settings/update" && failUpdate)
      throw new Error("Model update failed");
    if (method === "thread/resume" && failResume)
      throw new Error("Resume failed");
    if (method === "thread/resume" && onResume) return onResume(this);
    if (["thread/start", "thread/resume", "thread/fork"].includes(method))
      return {
        thread: {
          id: method === "thread/fork" ? "fork_1" : "root_1",
          turns: [],
        },
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };
    return {};
  };
  const client = new BusinessRuntime("codex", home);
  t.after(() => {
    CodexClient.prototype.request = original;
    rmSync(home, { recursive: true, force: true });
  });
  return {
    client,
    home,
    sent,
    failUpdate: (value: boolean) => {
      failUpdate = value;
    },
    failResume: (value: boolean) => {
      failResume = value;
    },
    resolveModel: (value: string | undefined) => {
      resolvedModel = value;
    },
    onResume: (action: (client: CodexClient) => any) => {
      onResume = action;
    },
  };
}
const call = (client: BusinessRuntime, threadId = "root_1", args: any = {}) =>
  client.executeTool({ threadId, tool: "get_model_info", arguments: args });
async function info(client: BusinessRuntime, threadId?: string) {
  const result = await call(client, threadId);
  assert.equal(result.success, true);
  return JSON.parse(result.contentItems[0].text);
}
const config = {
  model: "public-model-a",
  modelProvider: "profile_secret_internal_route",
  publicModelProvider: "OpenAI",
  config: {
    "model_providers.profile_secret_internal_route": {
      name: "Private gateway",
      base_url: "https://internal.example.invalid/v1",
      experimental_bearer_token: "private-key-value",
    },
  },
};

test("model identity is server-owned, public and excluded from engine parameters", async (t) => {
  const { client, home, sent, resolveModel } = fixture(t);
  const manager = new ThreadManager(client, home);
  t.after(() => manager.close());
  resolveModel("resolved-public-model");
  await manager.create(config);
  const start = sent[0].params;
  assert.equal(start.publicModelProvider, undefined);
  const tool = start.dynamicTools.find(
    (tool: any) => tool.name === "get_model_info",
  );
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(start.baseInstructions, /call get_model_info/);
  assert.deepEqual(await info(client), {
    model: "resolved-public-model",
    provider: "OpenAI",
  });
  assert.doesNotMatch(
    JSON.stringify(await info(client)),
    /secret_internal_route|internal.example|private-key/,
  );
});

test("successful model changes update identity and forks, failed changes preserve it", async (t) => {
  const { client, failUpdate } = fixture(t);
  await client.request("thread/start", config);
  await client.request("thread/settings/update", {
    threadId: "root_1",
    model: "public-model-b",
  });
  assert.deepEqual(await info(client), {
    model: "public-model-b",
    provider: "OpenAI",
  });
  failUpdate(true);
  await assert.rejects(
    client.request("thread/settings/update", {
      threadId: "root_1",
      model: "rejected-model",
    }),
    /update failed/,
  );
  assert.equal((await info(client)).model, "public-model-b");
  await client.request("thread/fork", { threadId: "root_1" });
  assert.deepEqual(await info(client, "fork_1"), {
    model: "public-model-b",
    provider: "OpenAI",
  });
});

test("running turns retain their answering model, reroutes apply only to the matching turn", async (t) => {
  const { client } = fixture(t);
  await client.request("thread/start", config);
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "turn_1" } },
  });
  await client.request("thread/settings/update", {
    threadId: "root_1",
    model: "next-turn-model",
  });
  assert.equal((await info(client)).model, "public-model-a");
  client.emit("notification", {
    method: "model/rerouted",
    params: {
      threadId: "root_1",
      turnId: "unrelated-turn",
      toModel: "wrong-model",
    },
  });
  assert.equal((await info(client)).model, "public-model-a");
  client.emit("notification", {
    method: "model/rerouted",
    params: { threadId: "root_1", turnId: "turn_1", toModel: "rerouted-model" },
  });
  assert.deepEqual(await info(client), {
    model: "rerouted-model",
    provider: "OpenAI",
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "unrelated-turn" } },
  });
  assert.equal((await info(client)).model, "rerouted-model");
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "turn_1" } },
  });
  assert.equal((await info(client)).model, "next-turn-model");
});

test("identity survives restart and successful resume uses the actual selected model", async (t) => {
  const { client, home, resolveModel, failResume } = fixture(t);
  await client.request("thread/start", config);
  const reloaded = new BusinessRuntime("codex", home);
  assert.deepEqual(await info(reloaded), {
    model: "public-model-a",
    provider: "OpenAI",
  });
  resolveModel("runtime-selected-model");
  await reloaded.request("thread/resume", { threadId: "root_1" });
  assert.deepEqual(await info(reloaded), {
    model: "runtime-selected-model",
    provider: "OpenAI",
  });
  failResume(true);
  await assert.rejects(
    reloaded.request("thread/resume", {
      threadId: "root_1",
      model: "not-applied",
      publicModelProvider: "Other",
    }),
    /Resume failed/,
  );
  assert.deepEqual(await info(reloaded), {
    model: "runtime-selected-model",
    provider: "OpenAI",
  });
});

test("provider changes use only explicit public metadata and never infer routing IDs", async (t) => {
  const { client } = fixture(t);
  await client.request("thread/start", config);
  await client.request("thread/resume", {
    threadId: "root_1",
    model: "claude-model",
    modelProvider: "profile_private_anthropic",
    publicModelProvider: "Anthropic",
  });
  assert.deepEqual(await info(client), {
    model: "claude-model",
    provider: "Anthropic",
  });
  await client.request("thread/resume", {
    threadId: "root_1",
    modelProvider: "profile_unknown",
  });
  assert.deepEqual(await info(client), {
    model: "claude-model",
    provider: null,
  });
});

test("turns starting before the resume response never freeze stale identity", async (t) => {
  const { client, onResume } = fixture(t);
  await client.request("thread/start", config);
  onResume(async (runtime) => {
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "root_1", turn: { id: "resumed-turn" } },
    });
    assert.deepEqual(await info(client), { model: null, provider: null });
    return {
      thread: { id: "root_1", status: { type: "active" }, turns: [] },
      model: "new-model",
    };
  });
  await client.request("thread/resume", {
    threadId: "root_1",
    model: "new-model",
    publicModelProvider: "Other provider",
  });
  assert.deepEqual(await info(client), { model: null, provider: null });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "resumed-turn" } },
  });
  assert.deepEqual(await info(client), {
    model: "new-model",
    provider: "Other provider",
  });
});

test("cold resume of an already-running turn reports unavailable instead of future settings", async (t) => {
  const { client, home, onResume } = fixture(t);
  await client.request("thread/start", config);
  const reloaded = new BusinessRuntime("codex", home);
  onResume(() => ({
    thread: {
      id: "root_1",
      status: { type: "active" },
      turns: [{ id: "existing-turn", status: "inProgress" }],
    },
    model: "future-turn-model",
  }));
  await reloaded.request("thread/resume", { threadId: "root_1" });
  assert.deepEqual(await info(reloaded), { model: null, provider: null });
  reloaded.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "existing-turn" } },
  });
  assert.deepEqual(await info(reloaded), { model: null, provider: null });
  reloaded.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "existing-turn" } },
  });
  reloaded.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "next-turn" } },
  });
  assert.deepEqual(await info(reloaded), {
    model: "future-turn-model",
    provider: "OpenAI",
  });
});

test("resume without active turn history stays unavailable until completion; duplicate starts preserve known identity", async (t) => {
  const { client, home, onResume } = fixture(t);
  await client.request("thread/start", config);
  const reloaded = new BusinessRuntime("codex", home);
  onResume(() => ({
    thread: { id: "root_1", status: { type: "active" }, turns: [] },
    model: "future-model",
  }));
  await reloaded.request("thread/resume", { threadId: "root_1" });
  assert.deepEqual(await info(reloaded), { model: null, provider: null });
  reloaded.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "unobserved-turn" } },
  });
  assert.deepEqual(await info(reloaded), { model: null, provider: null });
  reloaded.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "unobserved-turn" } },
  });
  reloaded.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "known-turn" } },
  });
  await reloaded.request("thread/settings/update", {
    threadId: "root_1",
    model: "later-model",
  });
  reloaded.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "known-turn" } },
  });
  assert.deepEqual(await info(reloaded), {
    model: "future-model",
    provider: "OpenAI",
  });
});

test("unknown, legacy or invalid identity stays unavailable without disclosing configuration", async (t) => {
  const { client, home } = fixture(t);
  await client.request("thread/start", {
    modelProvider: "profile_secret",
    publicModelProvider: "Injected\nrole",
  });
  assert.deepEqual(await info(client), { model: null, provider: null });
  const marker = join(home, "business-threads/root_1.json");
  const record = JSON.parse(readFileSync(marker, "utf8"));
  delete record.modelIdentity;
  writeFileSync(marker, JSON.stringify(record));
  assert.deepEqual(await info(client), { model: null, provider: null });
  for (const args of [null, [], { threadId: "other" }, { model: "fake" }])
    assert.equal((await call(client, "root_1", args)).success, false);
  assert.equal((await call(client, "../private")).success, false);
  client.helpers.add("helper_1");
  assert.equal((await call(client, "helper_1")).success, false);
});

test("successful engine model update with failed persistence never discloses the previous marker identity", async (t) => {
  const { client, home, sent } = fixture(t);
  await client.request("thread/start", config);
  const marker = join(home, "business-threads/root_1.json");
  const before = readFileSync(marker, "utf8");
  const rename = t.mock.method(fs, "renameSync", () => {
    throw new Error("Identity persistence failed");
  });
  await assert.rejects(
    client.request("thread/settings/update", {
      threadId: "root_1",
      model: "new-engine-model",
    }),
    /Identity persistence failed/,
  );
  assert.equal(sent.at(-1)?.method, "thread/settings/update");
  assert.equal(
    readFileSync(marker, "utf8"),
    before,
    "Atomic update retains the original workspace marker",
  );
  assert.deepEqual(await info(client), { model: null, provider: null });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "post-failure-turn" } },
  });
  assert.deepEqual(await info(client), { model: null, provider: null });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "post-failure-turn" } },
  });
  rename.mock.restore();
  await client.request("thread/resume", {
    ...config,
    threadId: "root_1",
    model: "new-engine-model",
  });
  assert.deepEqual(await info(client), {
    model: "new-engine-model",
    provider: "OpenAI",
  });
});

test("resume persistence failure invalidates old identity even after the engine applied new settings", async (t) => {
  const { client, home, resolveModel } = fixture(t);
  await client.request("thread/start", config);
  const marker = join(home, "business-threads/root_1.json");
  const before = readFileSync(marker, "utf8");
  resolveModel("resolved-new-model");
  const rename = t.mock.method(fs, "renameSync", () => {
    throw new Error("Resume identity persistence failed");
  });
  await assert.rejects(
    client.request("thread/resume", {
      ...config,
      threadId: "root_1",
      publicModelProvider: "New provider",
    }),
    /Resume identity persistence failed/,
  );
  assert.equal(readFileSync(marker, "utf8"), before);
  assert.deepEqual(await info(client), { model: null, provider: null });
  rename.mock.restore();
  await client.request("thread/resume", {
    ...config,
    threadId: "root_1",
    publicModelProvider: "New provider",
  });
  assert.deepEqual(await info(client), {
    model: "resolved-new-model",
    provider: "New provider",
  });
});
