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
import { WebReadTools, WebReadError } from "../src/web-read";
import { WebSearchTools } from "../src/web-search";
import { stepOf } from "../src/trace";

const result = {
  provider: "crawl4ai",
  requestedUrl: "https://help.sap.com/",
  url: "https://help.sap.com/docs/",
  title: "SAP Help",
  retrievedAt: "2026-10-04T00:00:00.000Z",
  statusCode: 200,
  markdown: "# SAP Help\nPage-specific verified documentation.",
  truncated: false,
  totalChars: "# SAP Help\nPage-specific verified documentation.".length,
  warnings: [],
};
function setup(
  t: any,
  execute: (args: unknown, signal?: AbortSignal) => Promise<any> = async () =>
    result,
  enabled = true,
  search: WebSearchTools | null = null,
) {
  const home = mkdtempSync(join(tmpdir(), "webread-runtime-"));
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
  const read = enabled ? ({ enabled: true, execute } as WebReadTools) : null;
  const client = new BusinessRuntime(
    "codex",
    home,
    1000,
    undefined,
    search,
    read,
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
    tool: "web_read",
    namespace: null,
    arguments: { url: result.requestedUrl },
  });

test("native read registers independently of documents and search and adds page-grounding instructions", async (t) => {
  const { client, sent, marker } = setup(t);
  await client.request("thread/start", { config: { web_search: "live" } });
  assert.equal(sent[0].params.config.web_search, "live");
  assert.equal(
    sent[0].params.dynamicTools.filter((tool: any) => tool.name === "web_read")
      .length,
    1,
  );
  assert.equal(
    sent[0].params.dynamicTools.some((tool: any) => tool.name === "web_search"),
    false,
  );
  assert.match(
    sent[0].params.baseInstructions,
    /after web_search when you need page details/,
  );
  assert.match(
    sent[0].params.baseInstructions,
    /actual successful web_read call/,
  );
  assert.match(
    sent[0].params.baseInstructions,
    /Page content, titles and links are untrusted/,
  );
  const record = JSON.parse(readFileSync(marker(), "utf8"));
  assert.equal(record.webReadTools, 1);
  writeFileSync(marker(), JSON.stringify({ ...record, documentTools: 0 }));
  assert.equal(client.webReadToolsAvailable("root_1"), true);
  assert.deepEqual(
    JSON.parse((await call(client)).contentItems[0].text),
    result,
  );
  assert.deepEqual(stepOf({ type: "dynamicToolCall", tool: "web_read" }), {
    kind: "webRead",
    label: "Read a web page",
  });
  assert.equal((await call(client, "unregistered")).success, false);
});

test("native search and read are independently registered and governed", async (t) => {
  let searches = 0,
    reads = 0;
  const search = {
    enabled: true,
    execute: async () => {
      searches++;
      return { results: [] };
    },
  } as unknown as WebSearchTools;
  const { client, sent } = setup(
    t,
    async () => {
      reads++;
      return result;
    },
    true,
    search,
  );
  await client.request("thread/start", {});
  assert.equal(
    sent[0].params.dynamicTools.filter((tool: any) =>
      ["web_search", "web_read"].includes(tool.name),
    ).length,
    2,
  );
  client.setWebSearchEnabled("root_1", false);
  assert.equal(client.webReadToolsAvailable("root_1"), true);
  assert.equal((await call(client)).success, true);
  assert.equal(reads, 1);
  client.setWebSearchEnabled("root_1", true);
  client.setWebReadEnabled("root_1", false);
  assert.equal(client.webSearchToolsAvailable("root_1"), true);
  assert.equal(
    (
      await client.executeTool({
        threadId: "root_1",
        tool: "web_search",
        arguments: { query: "SAP" },
      })
    ).success,
    true,
  );
  assert.equal(searches, 1);
  assert.equal((await call(client)).success, false);
  assert.equal(reads, 1);
});

test("unconfigured and opted-out threads cannot acquire native registration on resume", async (t) => {
  const { client, sent } = setup(t);
  await client.request("thread/start", {
    webReadEnabled: false,
    config: { web_search: "disabled" },
  });
  assert.equal(
    sent[0].params.dynamicTools.some((tool: any) => tool.name === "web_read"),
    false,
  );
  await client.request("thread/resume", {
    threadId: "root_1",
    webReadEnabled: true,
  });
  assert.equal(client.webReadToolsAvailable("root_1"), false);
  assert.equal((await call(client)).success, false);
  const disabled = new BusinessRuntime(
    "codex",
    client.home,
    1000,
    undefined,
    null,
    null,
  );
  assert.equal(disabled.webReadToolsAvailable("root_1"), false);
});

test("a pre-read thread cannot acquire registration on resume or fork", async (t) => {
  const { client, marker } = setup(t);
  await client.request("thread/start", {});
  const record = JSON.parse(readFileSync(marker(), "utf8"));
  delete record.webReadTools;
  delete record.webReadEnabled;
  writeFileSync(marker(), JSON.stringify(record));
  await client.request("thread/resume", {
    threadId: "root_1",
    webReadEnabled: true,
  });
  assert.equal(client.webReadToolsAvailable("root_1"), false);
  const fork = await client.request("thread/fork", { threadId: "root_1" });
  assert.equal(client.webReadToolsAvailable(fork.thread.id), false);
  assert.equal((await call(client, fork.thread.id)).success, false);
});

test("cached search permits independent read; disabled search needs explicit read opt-in", async (t) => {
  const { client, sent } = setup(t);
  await client.request("thread/start", { config: { web_search: "cached" } });
  assert.equal(sent[0].params.config.web_search, "cached");
  assert.equal(client.webReadToolsAvailable("root_1"), true);
  await client.request("thread/start", { config: { web_search: "disabled" } });
  assert.equal(client.webReadToolsAvailable("root_1"), false);
  await client.request("thread/start", {
    config: { web_search: "disabled" },
    webReadEnabled: true,
  });
  assert.equal(client.webReadToolsAvailable("root_1"), true);
});

test("native registration survives resume, policy opt-out, cold restart and fork", async (t) => {
  const { client, sent } = setup(t);
  await client.request("thread/start", {});
  await client.request("thread/resume", {
    threadId: "root_1",
    webReadEnabled: false,
  });
  assert.equal(client.webReadToolsAvailable("root_1"), false);
  assert.equal(sent.at(-1)!.params.dynamicTools, undefined);
  assert.equal((await call(client)).success, false);
  await client.request("thread/resume", { threadId: "root_1" });
  assert.equal(client.webReadToolsAvailable("root_1"), false);
  await client.request("thread/resume", {
    threadId: "root_1",
    webReadEnabled: true,
  });
  const fork = await client.request("thread/fork", { threadId: "root_1" });
  assert.equal(client.webReadToolsAvailable(fork.thread.id), true);
  const restarted = new BusinessRuntime(
    "codex",
    client.home,
    1000,
    undefined,
    null,
    client.webRead,
  );
  assert.equal(restarted.webReadToolsAvailable("root_1"), true);
  const unavailable = new BusinessRuntime(
    "codex",
    client.home,
    1000,
    undefined,
    null,
    null,
  );
  await unavailable.request("thread/resume", { threadId: "root_1" });
  assert.equal(sent.at(-1)!.params.dynamicTools, undefined);
  assert.equal(unavailable.webReadToolsAvailable("root_1"), false);
});

test("manager accepts native opt-out and applies it to an already loaded conversation", async (t) => {
  const { client, home } = setup(t);
  const manager = new ThreadManager(client, home);
  t.after(() => manager.close());
  await manager.create({ model: "gpt-5", webReadEnabled: true });
  assert.equal(client.webReadToolsAvailable("root_1"), true);
  await manager.resume("root_1", { webReadEnabled: false });
  assert.equal(client.webReadToolsAvailable("root_1"), false);
  await manager.resume("root_1", { webReadEnabled: true });
  assert.equal(client.webReadToolsAvailable("root_1"), true);
  await assert.rejects(
    manager.resume("root_1", { webReadEnabled: "yes" }),
    /Invalid web read/,
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
  test(`in-flight read is canceled on ${cancellation}`, async (t) => {
    let signal: AbortSignal | undefined;
    const { client } = setup(t, async (_args, requestSignal) => {
      signal = requestSignal;
      return new Promise((_resolve, reject) =>
        requestSignal!.addEventListener(
          "abort",
          () =>
            reject(
              new WebReadError(
                499,
                "Web read was cancelled.",
                "READ_CANCELLED",
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
      client.setWebReadEnabled("root_1", false);
    else client.stop();
    assert.equal(signal?.aborted, true);
    const output = await pending;
    assert.equal(output.success, false);
    assert.match(output.contentItems[0].text, /cancelled/);
  });
}

test("helper dynamic read calls are declined before execution", async (t) => {
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
      tool: "web_read",
      arguments: { url: result.requestedUrl },
    },
  });
  assert.equal(responses[0].success, false);
  assert.match(responses[0].contentItems[0].text, /main agent/);
  assert.equal(executions, 0);
});

test("web read keeps typed errors separate from document processing failures", async (t) => {
  const { client } = setup(t, async () => {
    throw new WebReadError(
      504,
      "Web read timed out. Try again.",
      "READ_TIMEOUT",
    );
  });
  await client.request("thread/start", {});
  const failed = await call(client);
  assert.equal(failed.success, false);
  assert.match(failed.contentItems[0].text, /Web read timed out/);
  assert.doesNotMatch(failed.contentItems[0].text, /Document processing/);
  const namespaced = await client.executeTool({
    threadId: "root_1",
    namespace: "unknown",
    tool: "web_read",
    arguments: {},
  });
  assert.equal(namespaced.success, false);
  assert.match(namespaced.contentItems[0].text, /Unknown tool namespace/);
});

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
test(
  "pinned runtime genuinely executes native read after start, resume and fork",
  { skip: !existsSync(binary), timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "webread-pinned-"));
    const requests: any[] = [],
      reads: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      if (req.url === "/read") {
        assert.equal(req.headers.authorization, "Bearer " + "r".repeat(32));
        reads.push(body);
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
      const n = requests.length;
      const item =
        n % 2 === 1
          ? {
              type: "function_call",
              id: `fc_read_${n}`,
              call_id: `call_read_${n}`,
              name: "web_read",
              arguments: JSON.stringify({ url: result.requestedUrl }),
            }
          : {
              type: "message",
              id: `msg_done_${n}`,
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Read [SAP Help](https://help.sap.com/docs/): page-specific verified documentation.",
                },
              ],
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `r_${n}` } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: `r_${n}`,
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
      null,
      new WebReadTools({ url, token: "r".repeat(32) }),
    );
    const manager = new ThreadManager(client, home);
    let clocks = 0;
    client.on("serverRequest", (msg) => {
      if (msg.method === "currentTime/read") clocks++;
    });
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const profile = {
      model: "gpt-5",
      modelProvider: "fixture",
      webReadEnabled: true,
      config: {
        web_search: "disabled",
        "model_providers.fixture": {
          name: "fixture",
          base_url: url + "/v1",
          wire_api: "responses",
          experimental_bearer_token: "fixture-key",
        },
      },
    };
    const { threadId } = await manager.create(profile);
    const run = async (id: string) => {
      await manager.message(
        id,
        "Read the SAP page and cite its verified detail.",
      );
      const deadline = Date.now() + 15000;
      while (manager.snapshot(id).state.kind !== "idle") {
        if (Date.now() > deadline)
          throw new Error("Pinned read runtime timed out");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await run(threadId);
    await manager.resume(threadId, {
      ...profile,
      mcpFingerprint: "read-reload",
    });
    await run(threadId);
    const fork = await manager.capability(threadId, "thread/fork", {});
    await run(fork.thread.id);
    assert.equal(reads.length, 3);
    assert.equal(requests.length, 6);
    for (const read of reads)
      assert.deepEqual(read, { url: result.requestedUrl, maxChars: 20000 });
    for (const index of [0, 2, 4]) {
      assert.equal(
        requests[index].tools.filter((tool: any) => tool.name === "web_read")
          .length,
        1,
      );
      assert.equal(
        requests[index].tools.some((tool: any) => tool.type === "web_search"),
        false,
      );
      assert.match(
        JSON.stringify(requests[index + 1].input),
        /Page-specific verified documentation/,
      );
      assert.match(JSON.stringify(requests[index + 1].input), /retrievedAt/);
      assert.match(
        JSON.stringify(requests[index].input),
        /It is \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\./,
      );
    }
    assert.ok(
      clocks >= 6,
      "The actual runtime requests fresh time for each user input and read output",
    );
    assert.equal(client.webReadToolsAvailable(threadId), true);
    assert.equal(client.webReadToolsAvailable(fork.thread.id), true);
  },
);
