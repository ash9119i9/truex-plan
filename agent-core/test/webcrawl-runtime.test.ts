import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../src/client";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { WebCrawlTools } from "../src/web-crawl";
import { stepOf } from "../src/trace";

function setup(t: any) {
  const home = mkdtempSync(join(tmpdir(), "crawl-runtime-"));
  const sent: any[] = [],
    operations: any[] = [];
  const original = CodexClient.prototype.request;
  let count = 0;
  CodexClient.prototype.request = async function (method, params) {
    sent.push({ method, params });
    return {
      thread: {
        id:
          method === "thread/start"
            ? `root_${++count}`
            : method === "thread/fork"
              ? "fork_1"
              : params.threadId,
        turns: [],
      },
    };
  };
  const tools = {
    enabled: true,
    execute: async (args: any, identity: any, signal: any, callId: any) => {
      operations.push({ args, identity, signal, callId });
      return { jobId: "11111111-1111-4111-8111-111111111111", state: "queued" };
    },
    list: async (identity: any) => {
      operations.push({ action: "list", identity });
      return { jobs: [] };
    },
    purge: async (identity: any) => {
      operations.push({ action: "purge", identity });
      return { ok: true };
    },
  } as unknown as WebCrawlTools;
  const client = new BusinessRuntime(
    "codex",
    home,
    1000,
    undefined,
    null,
    null,
    tools,
  );
  t.after(() => {
    client.stop();
    CodexClient.prototype.request = original;
    rmSync(home, { recursive: true, force: true });
  });
  const marker = (id = "root_1") =>
    join(home, "business-threads", id + ".json");
  const call = (args: any, id = "root_1") =>
    client.executeTool({
      threadId: id,
      callId: "actual_dynamic_call",
      tool: "web_crawl",
      arguments: args,
    });
  return { home, client, sent, operations, marker, call, tools };
}

test("crawl registration is independent, main-only, and identity is trusted", async (t) => {
  const { client, sent, operations, marker, call } = setup(t);
  await client.request("thread/start", {
    tenantId: "acme",
    config: { web_search: "cached" },
  });
  assert.equal(
    sent[0].params.dynamicTools.filter((tool: any) => tool.name === "web_crawl")
      .length,
    1,
  );
  const record = JSON.parse(readFileSync(marker(), "utf8"));
  assert.equal(record.crawlSessionId, "root_1");
  writeFileSync(marker(), JSON.stringify({ ...record, documentTools: 0 }));
  assert.equal(
    (await call({ action: "start", url: "https://example.com" })).success,
    true,
  );
  assert.deepEqual(operations[0].identity, {
    tenantId: "acme",
    sessionId: "root_1",
  });
  assert.equal(operations[0].callId, "actual_dynamic_call");
  assert.equal(
    (
      await call({
        action: "start",
        url: "https://example.com",
        tenantId: "victim",
      })
    ).success,
    false,
  );
  assert.equal(
    (
      await call(
        { action: "status", jobId: "11111111-1111-4111-8111-111111111111" },
        "unknown",
      )
    ).success,
    false,
  );
  client.helpers.add("helper_1");
  assert.equal(
    (
      await call(
        { action: "status", jobId: "11111111-1111-4111-8111-111111111111" },
        "helper_1",
      )
    ).success,
    false,
  );
  assert.equal(operations.length, 1);
  assert.deepEqual(
    stepOf({
      type: "dynamicToolCall",
      tool: "web_crawl",
      arguments: { action: "results", url: "secret" },
    }),
    { kind: "webCrawl", label: "Read crawl results" },
  );
  assert.deepEqual(
    stepOf({
      type: "dynamicToolCall",
      tool: "web_crawl",
      arguments: { action: "toString" },
    }),
    { kind: "webCrawl", label: "Used web crawl" },
  );
});

test("policy stops new jobs while preserving retrieval and cancel after resume and restart", async (t) => {
  const { client, home, tools, call } = setup(t);
  const manager = new ThreadManager(client, home);
  t.after(() => manager.close());
  await manager.create({ model: "gpt-5", webCrawlEnabled: true });
  await manager.resume("root_1", { webCrawlEnabled: false });
  assert.equal(client.webCrawlToolsAvailable("root_1"), false);
  assert.equal(
    (await call({ action: "start", url: "https://example.com" })).success,
    false,
  );
  for (const action of ["status", "results", "cancel"])
    assert.equal(
      (await call({ action, jobId: "11111111-1111-4111-8111-111111111111" }))
        .success,
      true,
    );
  await client.listCrawls("root_1");
  const restarted = new BusinessRuntime(
    "codex",
    home,
    1000,
    undefined,
    null,
    null,
    tools,
  );
  assert.equal(restarted.webCrawlToolsAvailable("root_1"), false);
  await restarted.cancelCrawl("root_1", "11111111-1111-4111-8111-111111111111");
  await assert.rejects(
    manager.resume("root_1", { webCrawlEnabled: "yes" }),
    /Invalid web crawl/,
  );
});

test("old threads cannot acquire crawl on resume; forks have separate scope and no job state", async (t) => {
  const { client, marker, call, operations } = setup(t);
  await client.request("thread/start", {});
  const fork = await client.request("thread/fork", { threadId: "root_1" });
  assert.equal(client.webCrawlToolsAvailable(fork.thread.id), true);
  await call(
    { action: "status", jobId: "11111111-1111-4111-8111-111111111111" },
    fork.thread.id,
  );
  assert.equal(operations[0].identity.sessionId, fork.thread.id);
  const forkRecord = JSON.parse(readFileSync(marker(fork.thread.id), "utf8"));
  assert.deepEqual(
    Object.keys(forkRecord).filter((key) => /job/i.test(key)),
    [],
  );
  const old = JSON.parse(readFileSync(marker(), "utf8"));
  delete old.webCrawlTools;
  delete old.webCrawlEnabled;
  delete old.crawlSessionId;
  writeFileSync(marker(), JSON.stringify(old));
  await client.request("thread/resume", {
    threadId: "root_1",
    webCrawlEnabled: true,
  });
  assert.equal(client.webCrawlToolsAvailable("root_1"), false);
  assert.equal(
    (
      await call({
        action: "status",
        jobId: "11111111-1111-4111-8111-111111111111",
      })
    ).success,
    false,
  );
});

test("deletion purges scope before runtime delete and marker removal, retaining marker on cleanup failure", async (t) => {
  const { client, marker, operations, sent, tools } = setup(t);
  await client.request("thread/start", {});
  tools.purge = async () => {
    throw new Error("unreachable");
  };
  await assert.rejects(
    client.request("thread/delete", { threadId: "root_1" }),
    /unreachable/,
  );
  assert.equal(existsSync(marker()), true);
  assert.equal(
    sent.some((entry) => entry.method === "thread/delete"),
    false,
  );
  tools.purge = async (identity) => {
    assert.equal(existsSync(marker()), true);
    operations.push({ action: "purge", identity });
    return { ok: true };
  };
  client.setWebCrawlEnabled("root_1", false);
  await client.request("thread/delete", { threadId: "root_1" });
  assert.equal(operations.at(-1).action, "purge");
  assert.equal(existsSync(marker()), false);
});

test("global crawl service disable fails deletion without losing registered scope", async (t) => {
  const { client, home, marker, sent } = setup(t);
  await client.request("thread/start", {});
  const disabled = new BusinessRuntime(
    "codex",
    home,
    1000,
    undefined,
    null,
    null,
    null,
  );
  await assert.rejects(
    disabled.request("thread/delete", { threadId: "root_1" }),
    { code: "CRAWL_UNAVAILABLE" },
  );
  assert.equal(existsSync(marker()), true);
  assert.equal(
    sent.some((entry) => entry.method === "thread/delete"),
    false,
  );
});

for (const stop of ["interrupt", "completed", "exit", "stop"]) {
  test(`crawl RPC wait aborts on ${stop} without cancelling durable job`, async (t) => {
    const { client, tools, call, operations } = setup(t);
    await client.request("thread/start", {});
    let signal: AbortSignal;
    tools.execute = async (_input, _identity, requestSignal) => {
      signal = requestSignal!;
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("RPC aborted")),
          { once: true },
        ),
      );
    };
    const pending = call({
      action: "status",
      jobId: "11111111-1111-4111-8111-111111111111",
    });
    if (stop === "interrupt")
      await client.request("turn/interrupt", {
        threadId: "root_1",
        turnId: "turn_1",
      });
    else if (stop === "completed")
      client.emit("notification", {
        method: "turn/completed",
        params: { threadId: "root_1" },
      });
    else if (stop === "exit") client.emit("exit", new Error("stopped"));
    else client.stop();
    assert.equal(signal!.aborted, true);
    assert.equal((await pending).success, false);
    assert.equal(operations.length, 0);
  });
}

test(
  "pinned runtime executes every crawl action across resume/fork and scopes deletion",
  { timeout: 30000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { resolve } = await import("node:path");
    const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
    if (!existsSync(binary)) {
      t.skip("Pinned runtime unavailable");
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "crawl-pinned-")),
      token = "c".repeat(32);
    const requests: any[] = [],
      calls: any[] = [],
      jobs = new Map<string, { session: string; job: any }>();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const makeJob = (jobId: string) => ({
      provider: "crawlee",
      jobId,
      seedUrl: "https://example.com/",
      state: "running",
      reason: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      expiresAt: "2026-10-11T00:00:00.000Z",
      deadlineAt: "2026-10-04T00:05:00.000Z",
      limits: {
        maxPages: 25,
        maxDepth: 2,
        maxDurationMs: 300000,
        maxBytes: 10485760,
        maxFrontier: 1000,
      },
      counts: {
        discovered: 2,
        attempted: 1,
        attempts: 1,
        succeeded: 1,
        failed: 0,
        pending: 1,
        storedBytes: 100,
      },
      warnings: [],
    });
    const page = {
      sourceId: "source_1",
      requestedUrl: "https://example.com/",
      url: "https://example.com/docs",
      title: "Docs",
      retrievedAt: "2026-10-04T00:00:00.000Z",
      statusCode: 200,
      depth: 0,
      markdown: "# Saved page",
      totalChars: 12,
      truncated: false,
    };
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const json = (value: any, status = 200) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(value));
      if (req.url?.startsWith("/crawl/jobs")) {
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        assert.equal(req.headers["x-truex-tenant-id"], "acme");
        const session = req.headers["x-truex-session-id"] as string;
        assert.ok(session);
        calls.push({
          method: req.method,
          url: req.url,
          body,
          session,
          key: req.headers["x-truex-idempotency-key"],
        });
        if (req.url === "/crawl/jobs") {
          if (req.method === "GET")
            return json({
              jobs: [...jobs.values()]
                .filter((j) => j.session === session)
                .map((j) => j.job),
            });
          if (req.method === "DELETE") {
            for (const [id, j] of jobs)
              if (j.session === session) jobs.delete(id);
            return json({ ok: true });
          }
          assert.match(
            req.headers["x-truex-idempotency-key"] as string,
            /^[a-f0-9]{64}$/,
          );
          assert.deepEqual(body, {
            url: "https://example.com/",
            maxPages: 25,
            maxDepth: 2,
          });
          const id = ids[Math.floor((requests.length - 1) / 5)],
            job = makeJob(id);
          jobs.set(id, { session, job });
          return json(job);
        }
        const id = req.url.split("/")[3],
          stored = jobs.get(id);
        if (!stored || stored.session !== session)
          return json({ code: "CRAWL_NOT_FOUND" }, 404);
        if (req.url.includes("/results"))
          return json({
            job: stored.job,
            pages: [page],
            failures: [],
            offset: 0,
            nextOffset: null,
            totalPages: 1,
          });
        if (req.url.endsWith("/cancel")) {
          stored.job = {
            ...stored.job,
            state: "cancelled",
            reason: "cancelled",
          };
          return json(stored.job);
        }
        return json(stored.job);
      }
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(body);
      const n = requests.length - 1,
        phase = n % 5,
        jobId = ids[Math.floor(n / 5)],
        action = ["start", "status", "results", "cancel"][phase];
      const item =
        phase < 4
          ? {
              type: "function_call",
              id: `fc_${n}`,
              call_id: `actual_crawl_${n}`,
              name: "web_crawl",
              arguments: JSON.stringify(
                action === "start"
                  ? { action, url: "https://example.com/" }
                  : { action, jobId },
              ),
            }
          : {
              type: "message",
              id: `msg_${n}`,
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Read saved [Docs](https://example.com/docs) and cancelled the background crawl.",
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
        null,
        new WebCrawlTools({ url, token }),
      ),
      manager = new ThreadManager(client, home);
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
      tenantId: "acme",
      webCrawlEnabled: true,
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
        "Crawl this public site, check status, read saved pages, and cancel the crawl.",
      );
      const deadline = Date.now() + 15000;
      while (manager.snapshot(id).state.kind !== "idle") {
        if (Date.now() > deadline)
          throw new Error("Pinned crawl runtime timed out");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await run(threadId);
    await manager.resume(threadId, {
      ...profile,
      mcpFingerprint: "crawl-reload",
    });
    await run(threadId);
    const fork = await manager.capability(threadId, "thread/fork", {});
    await assert.rejects(client.cancelCrawl(fork.thread.id, ids[0]), {
      code: "CRAWL_NOT_FOUND",
    });
    await run(fork.thread.id);
    assert.equal(requests.length, 15);
    assert.equal(
      calls.filter((c) => c.method === "POST" && c.url === "/crawl/jobs")
        .length,
      3,
    );
    assert.equal(
      calls.filter((c) => c.url.endsWith("/cancel") && c.session === threadId)
        .length,
      2,
    );
    assert.equal(
      calls.filter((c) => c.method === "POST" && c.url === "/crawl/jobs").at(-1)
        .session,
      fork.thread.id,
    );
    for (const index of [0, 5, 10]) {
      assert.equal(
        requests[index].tools.filter((tool: any) => tool.name === "web_crawl")
          .length,
        1,
      );
      assert.equal(
        requests[index].tools.some((tool: any) => tool.type === "web_search"),
        false,
      );
      assert.match(JSON.stringify(requests[index + 3].input), /# Saved page/);
      assert.match(JSON.stringify(requests[index + 3].input), /retrievedAt/);
    }
    await manager.resume(threadId, { webCrawlEnabled: false });
    assert.equal(client.webCrawlToolsAvailable(threadId), false);
    assert.equal((await client.listCrawls(threadId)).jobs.length, 2);
    await manager.capability(threadId, "thread/delete", {});
    assert.equal(
      existsSync(join(home, "business-threads", threadId + ".json")),
      false,
    );
    assert.equal(jobs.size, 1);
    assert.equal((await client.listCrawls(fork.thread.id)).jobs.length, 1);
  },
);
