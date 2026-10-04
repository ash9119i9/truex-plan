import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexClient } from "../src/client";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { WebSearchTools, WebSearchError } from "../src/web-search";
import { stepOf } from "../src/trace";

const result = {
  provider: "searxng",
  query: "SAP documentation",
  searchedAt: "2026-10-04T00:00:00.000Z",
  results: [
    {
      sourceId: "source_1",
      url: "https://help.sap.com/",
      title: "SAP Help",
      snippet: "Documentation",
      engines: ["bing"],
    },
  ],
  warnings: [],
};
function setup(
  t: any,
  execute: (args: unknown, signal?: AbortSignal) => Promise<any> = async () =>
    result,
  enabled = true,
) {
  const home = mkdtempSync(join(tmpdir(), "websearch-runtime-"));
  const sent: { method: string; params: any }[] = [];
  const original = CodexClient.prototype.request;
  CodexClient.prototype.request = async function (method: string, params: any) {
    sent.push({ method, params });
    return method === "thread/start"
      ? { thread: { id: "root_1" } }
      : method === "thread/fork"
        ? { thread: { id: "fork_1" } }
        : { thread: { id: "root_1", turns: [] } };
  };
  const search = enabled
    ? ({ enabled: true, execute } as WebSearchTools)
    : null;
  const client = new BusinessRuntime(
    "codex",
    home,
    1000,
    undefined,
    search,
    null,
  );
  t.after(() => {
    client.stop();
    CodexClient.prototype.request = original;
    rmSync(home, { recursive: true, force: true });
  });
  const marker = (id = "root_1") =>
    join(home, "business-threads", id + ".json");
  return { client, home, sent, marker };
}
const call = (client: BusinessRuntime, threadId = "root_1") =>
  client.executeTool({
    threadId,
    turnId: "turn_1",
    tool: "web_search",
    namespace: null,
    arguments: { query: result.query },
  });

test("freshness policy and external clock are enforced on start and resume", async (t) => {
  const { client, sent } = setup(t);
  const config = {
    include_environment_context: true,
    "features.current_time_reminder": {
      enabled: false,
      clock_source: "system",
      reminder_interval_seconds: 999999,
      delivery_mode: "any_inference",
      sleep_tool: true,
    },
    "features.current_time_reminder.enabled": false,
    "features.current_time_reminder.sleep_tool": true,
  };
  await client.request("thread/start", { config });
  await client.request("thread/resume", { threadId: "root_1", config });
  for (const request of sent) {
    assert.deepEqual(request.params.config["features.current_time_reminder"], {
      enabled: true,
      clock_source: "external",
      reminder_interval_seconds: 0,
      delivery_mode: "after_user_or_tool_output",
      sleep_tool: false,
    });
    assert.equal(request.params.config.include_environment_context, false);
    assert.equal(
      request.params.config["features.current_time_reminder.enabled"],
      undefined,
    );
    assert.equal(
      request.params.config["features.current_time_reminder.sleep_tool"],
      undefined,
    );
    assert.match(
      request.params.baseInstructions,
      /whose answer may have changed/,
    );
    assert.match(
      request.params.baseInstructions,
      /training knowledge does not establish the current state/,
    );
    assert.match(
      request.params.baseInstructions,
      /Respect an explicit request not to browse/,
    );
    assert.match(
      request.params.baseInstructions,
      /web_search before answering public factual questions/,
    );
  }
});

test("native search registers independently of documents and disables hosted search", async (t) => {
  const { client, sent, marker } = setup(t);
  await client.request("thread/start", { config: { web_search: "live" } });
  assert.equal(sent[0].params.config.web_search, "disabled");
  assert.equal(
    sent[0].params.dynamicTools.filter(
      (tool: any) => tool.name === "web_search",
    ).length,
    1,
  );
  assert.equal(client.webSearchToolsAvailable("root_1"), true);
  const record = JSON.parse(readFileSync(marker(), "utf8"));
  writeFileSync(marker(), JSON.stringify({ ...record, documentTools: 0 }));
  assert.deepEqual(
    JSON.parse((await call(client)).contentItems[0].text),
    result,
  );
  assert.deepEqual(stepOf({ type: "dynamicToolCall", tool: "web_search" }), {
    kind: "webSearch",
    label: "Searched the web",
  });
  assert.equal((await call(client, "unregistered")).success, false);
});

test("unconfigured and opted-out threads cannot acquire native registration on resume", async (t) => {
  const { client, sent } = setup(t);
  await client.request("thread/start", {
    webSearchEnabled: false,
    config: { web_search: "disabled" },
  });
  assert.equal(
    sent[0].params.dynamicTools.some((tool: any) => tool.name === "web_search"),
    false,
  );
  await client.request("thread/resume", {
    threadId: "root_1",
    webSearchEnabled: true,
  });
  assert.equal(client.webSearchToolsAvailable("root_1"), false);
  assert.equal((await call(client)).success, false);
  const disabled = new BusinessRuntime(
    "codex",
    client.home,
    1000,
    undefined,
    null,
    null,
  );
  assert.equal(disabled.webSearchToolsAvailable("root_1"), false);
});

test("cached-only profiles keep hosted cached search without live SearXNG registration", async (t) => {
  const { client, sent } = setup(t);
  await client.request("thread/start", { config: { web_search: "cached" } });
  assert.equal(sent[0].params.config.web_search, "cached");
  assert.equal(
    sent[0].params.dynamicTools.some((tool: any) => tool.name === "web_search"),
    false,
  );
  assert.equal(client.webSearchToolsAvailable("root_1"), false);
  assert.equal((await call(client)).success, false);
});

test("native registration survives resume, policy opt-out, cold restart and fork", async (t) => {
  const { client, sent } = setup(t);
  await client.request("thread/start", {});
  await client.request("thread/resume", {
    threadId: "root_1",
    webSearchEnabled: false,
  });
  assert.equal(client.webSearchToolsAvailable("root_1"), false);
  assert.equal(sent.at(-1)!.params.config.web_search, "disabled");
  assert.equal((await call(client)).success, false);
  await client.request("thread/resume", { threadId: "root_1" });
  assert.equal(client.webSearchToolsAvailable("root_1"), false);
  await client.request("thread/resume", {
    threadId: "root_1",
    webSearchEnabled: true,
  });
  const fork = await client.request("thread/fork", { threadId: "root_1" });
  assert.equal(client.webSearchToolsAvailable(fork.thread.id), true);
  const restarted = new BusinessRuntime(
    "codex",
    client.home,
    1000,
    undefined,
    client.webSearch,
    null,
    null,
  );
  assert.equal(restarted.webSearchToolsAvailable("root_1"), true);
  const unavailable = new BusinessRuntime(
    "codex",
    client.home,
    1000,
    undefined,
    null,
    null,
  );
  await unavailable.request("thread/resume", { threadId: "root_1" });
  assert.equal(sent.at(-1)!.params.config.web_search, "disabled");
  assert.equal(unavailable.webSearchToolsAvailable("root_1"), false);
});

test("manager accepts native opt-out and applies it to an already loaded conversation", async (t) => {
  const { client, home } = setup(t);
  const manager = new ThreadManager(client, home);
  t.after(() => manager.close());
  await manager.create({ model: "gpt-5", webSearchEnabled: true });
  assert.equal(client.webSearchToolsAvailable("root_1"), true);
  await manager.resume("root_1", { webSearchEnabled: false });
  assert.equal(client.webSearchToolsAvailable("root_1"), false);
  await manager.resume("root_1", { webSearchEnabled: true });
  assert.equal(client.webSearchToolsAvailable("root_1"), true);
  await assert.rejects(
    manager.resume("root_1", { webSearchEnabled: "yes" }),
    /Invalid web search/,
  );
});

for (const cancellation of [
  "interrupt",
  "delete",
  "completed",
  "exit",
  "stop",
  "policy",
]) {
  test(`in-flight search is canceled on ${cancellation}`, async (t) => {
    let signal: AbortSignal | undefined;
    const { client } = setup(t, async (_args, requestSignal) => {
      signal = requestSignal;
      return new Promise((_resolve, reject) =>
        requestSignal!.addEventListener(
          "abort",
          () =>
            reject(
              new WebSearchError(
                499,
                "Web search was cancelled.",
                "SEARCH_CANCELLED",
              ),
            ),
          { once: true },
        ),
      );
    });
    await client.request("thread/start", {});
    const pending = call(client);
    assert.equal(signal?.aborted, false);
    if (cancellation === "interrupt")
      await client.request("turn/interrupt", {
        threadId: "root_1",
        turnId: "turn_1",
      });
    else if (cancellation === "delete")
      await client.request("thread/delete", { threadId: "root_1" });
    else if (cancellation === "completed")
      client.emit("notification", {
        method: "turn/completed",
        params: { threadId: "root_1" },
      });
    else if (cancellation === "exit")
      client.emit("exit", new Error("Runtime stopped"));
    else if (cancellation === "policy")
      client.setWebSearchEnabled("root_1", false);
    else client.stop();
    assert.equal(signal?.aborted, true);
    const output = await pending;
    assert.equal(output.success, false);
    assert.match(output.contentItems[0].text, /cancelled/);
  });
}

test("helper dynamic search calls are declined before execution", async (t) => {
  let executions = 0;
  const { client, home } = setup(t, async () => {
    executions++;
    return result;
  });
  const manager = new ThreadManager(client, home);
  t.after(() => manager.close());
  const responses: any[] = [];
  client.respond = (_id, response) => {
    responses.push(response);
  };
  await manager.create({ model: "gpt-5" });
  client.emit("serverRequest", {
    id: 42,
    method: "item/tool/call",
    params: {
      threadId: "helper_1",
      tool: "web_search",
      arguments: { query: "SAP" },
    },
  });
  assert.equal(responses[0].success, false);
  assert.match(responses[0].contentItems[0].text, /main agent/);
  assert.equal(executions, 0);
});

test("web search keeps typed errors separate from document processing failures", async (t) => {
  const { client } = setup(t, async () => {
    throw new WebSearchError(
      504,
      "Web search timed out. Try again.",
      "SEARCH_TIMEOUT",
    );
  });
  await client.request("thread/start", {});
  const failed = await call(client);
  assert.equal(failed.success, false);
  assert.match(failed.contentItems[0].text, /Web search timed out/);
  assert.doesNotMatch(failed.contentItems[0].text, /Document processing/);
  const namespaced = await client.executeTool({
    threadId: "root_1",
    namespace: "unknown",
    tool: "web_search",
    arguments: {},
  });
  assert.equal(namespaced.success, false);
  assert.match(namespaced.contentItems[0].text, /Unknown tool namespace/);
});

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
test(
  "pinned runtime calls native search and supplies fresh time on start and resume",
  { skip: !existsSync(binary), timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "websearch-pinned-"));
    const requests: any[] = [],
      searches: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      if (req.url === "/search") {
        assert.equal(req.headers.authorization, "Bearer " + "s".repeat(32));
        searches.push(body);
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(result));
        return;
      }
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(body);
      const item =
        requests.length === 1
          ? {
              type: "function_call",
              id: "fc_search",
              call_id: "call_search",
              name: "web_search",
              arguments: JSON.stringify({ query: result.query }),
            }
          : {
              type: "message",
              id: "msg_done",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Found [SAP Help](https://help.sap.com/).",
                },
              ],
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "r_" + requests.length } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: "r_" + requests.length,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const client = new BusinessRuntime(
      binary,
      home,
      15000,
      undefined,
      new WebSearchTools({ url, token: "s".repeat(32) }),
      null,
    );
    const manager = new ThreadManager(client, home);
    let clockRequests = 0;
    client.on("serverRequest", (message) => {
      if (message.method === "currentTime/read") clockRequests++;
    });
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const { threadId } = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: url + "/v1",
          wire_api: "responses",
          experimental_bearer_token: "fixture-key",
        },
      },
    });
    await manager.message(threadId, "Search SAP documentation and cite it.");
    const deadline = Date.now() + 15000;
    while (manager.snapshot(threadId).state.kind !== "idle") {
      if (Date.now() > deadline) throw new Error("Runtime timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(searches.length, 1);
    assert.equal(searches[0].query, result.query);
    const tools = requests[0].tools.filter(
      (tool: any) => tool.name === "web_search",
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, "function");
    assert.equal(
      requests[0].tools.some((tool: any) => tool.type === "web_search"),
      false,
    );
    assert.match(
      JSON.stringify(requests.at(-1).input),
      /https:\/\/help.sap.com\//,
    );
    assert.equal(client.webSearchToolsAvailable(threadId), true);
    assert.ok(
      clockRequests >= 2,
      "Runtime must read the clock for user input and tool output",
    );
    const assertCurrentTime = (request: any) => {
      const reminder = JSON.stringify(request.input).match(
        /It is (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)\./,
      );
      assert.ok(
        reminder,
        "Model request must contain the runtime current-time reminder",
      );
      const supplied = Date.parse(
        reminder[1].replace(" UTC", "Z").replace(" ", "T"),
      );
      assert.ok(
        Math.abs(Date.now() - supplied) < 60_000,
        "Timestamp must reflect the server clock",
      );
    };
    assertCurrentTime(requests[0]);
    assert.doesNotMatch(JSON.stringify(requests[0].tools), /"name":"sleep"/);
    await manager.resume(threadId, {
      model: "gpt-5",
      modelProvider: "fixture",
      mcpFingerprint: "clock-reload",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: url + "/v1",
          wire_api: "responses",
          experimental_bearer_token: "fixture-key",
        },
      },
    });
    await manager.message(
      threadId,
      "Continue after resuming this conversation.",
    );
    const resumeDeadline = Date.now() + 15000;
    while (manager.snapshot(threadId).state.kind !== "idle") {
      if (Date.now() > resumeDeadline)
        throw new Error("Resumed runtime timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(requests.length, 3);
    assertCurrentTime(requests.at(-1));
    assert.ok(clockRequests >= 3);
  },
);
