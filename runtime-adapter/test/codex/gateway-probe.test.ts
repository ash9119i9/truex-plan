import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import {
  Harness,
  completed,
  runAnswering,
  type SseEvent,
} from "../support/harness";
import { McpFixture } from "../support/mcp-fixture";

// Probe for docs/ideas/mcp-gateway.md: the three assumptions the MCP gateway
// design rests on, checked on the real pinned Codex. A stub gateway sits
// between Codex and the MCP fixture: it accepts only the Truex caller token,
// swaps in the provider token, filters tools/list and can refuse or hold a
// tools/call. No adapter code changes; these are facts to design on.

const TRUEX_TOKEN = "TRUEX_CALLER_chat_token_5b1e";
const PROVIDER_TOKEN = "PROVIDER_SECRET_ghu_77c0d2";
const CONNECTOR = "fixture";
const NAMESPACE = `mcp__${CONNECTOR}`;

class StubGateway {
  readonly seenTokens: string[] = [];
  // Tools hidden from tools/list and refused on tools/call.
  blocked = new Set<string>();
  // Tools still listed but refused on tools/call (e.g. a write with no
  // server-side approval record).
  refusedOnCall = new Set<string>();
  // Milliseconds to hold a tools/call before forwarding it.
  holdMs = 0;
  url = "";
  private server!: Server;

  constructor(private readonly upstream: McpFixture) {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      this.seenTokens.push(token ?? "");
      // Any Truex caller token is accepted; a real gateway verifies the signature.
      if (!token?.startsWith("TRUEX_CALLER_")) {
        res
          .writeHead(401, {
            "www-authenticate": 'Bearer error="invalid_token"',
          })
          .end();
        return;
      }
      let msg: Record<string, unknown> = {};
      try {
        msg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // Forwarded as is.
      }
      const tool = (msg.params as { name?: string } | undefined)?.name;
      if (
        msg.method === "tools/call" &&
        tool &&
        (this.blocked.has(tool) || this.refusedOnCall.has(tool))
      ) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32602,
              message: `Truex gateway: tool ${tool} is not allowed in this chat.`,
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/call" && this.holdMs > 0)
        await new Promise((r) => setTimeout(r, this.holdMs));
      const headers: Record<string, string> = {
        authorization: `Bearer ${PROVIDER_TOKEN}`,
      };
      for (const name of ["content-type", "accept", "mcp-session-id"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const upstream = await fetch(this.upstream.url, {
        method: req.method,
        headers,
        ...(req.method === "POST" ? { body: raw } : {}),
      });
      let body = await upstream.text();
      if (msg.method === "tools/list" && upstream.ok) {
        const parsed = JSON.parse(body) as {
          result: { tools: Array<{ name: string }> };
        };
        parsed.result.tools = parsed.result.tools.filter(
          (t) => !this.blocked.has(t.name),
        );
        body = JSON.stringify(parsed);
      }
      const out: Record<string, string> = {};
      for (const name of ["content-type", "mcp-session-id"]) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      res.writeHead(upstream.status, out).end(body);
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}/mcp`;
  }

  reset(): void {
    this.seenTokens.length = 0;
    this.blocked = new Set();
    this.refusedOnCall = new Set();
    this.holdMs = 0;
  }

  async close(): Promise<void> {
    if (!this.server?.listening) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function spec(gateway: StubGateway, token = TRUEX_TOKEN, toolTimeoutSec = 30) {
  return [
    {
      name: CONNECTOR,
      url: gateway.url,
      headers: { Authorization: `Bearer ${token}` },
      toolTimeoutSec,
      startupTimeoutSec: 15,
    },
  ];
}

function of(events: SseEvent[], type: string) {
  return events.filter((e) => e.type === type).map((e) => e.data);
}

describe("MCP gateway probe (real Codex)", () => {
  const fixture = new McpFixture();
  const gateway = new StubGateway(fixture);
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(async () => {
    await fixture.start();
    await gateway.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await gateway.close();
    await fixture.close();
  });

  // Assumption 3: Codex treats the gateway like any streamable-HTTP MCP
  // server, approvals included, and only the gateway sees the provider token.
  test("read and approved write go through the gateway; tokens stay on their side", async () => {
    fixture.reset();
    gateway.reset();
    h.model.script.length = 0;
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({
      kind: "call",
      name: "create_issue",
      namespace: NAMESPACE,
      args: { title: "via gateway" },
    });
    h.model.script.push({ kind: "reply", text: "done" });
    const body = h.body({ chatId: "gw1", mcp: spec(gateway) });
    const { events } = await runAnswering(h, body, () => "allow");

    assert.equal(completed(events).status, "completed");
    assert.deepEqual(
      of(events, "tool.completed").map((t) => [t.tool, t.status]),
      [
        ["get_issue", "completed"],
        ["create_issue", "completed"],
      ],
    );
    assert.equal(of(events, "approval.requested").length, 1);
    assert.deepEqual([...new Set(gateway.seenTokens)], [TRUEX_TOKEN]);
    assert.deepEqual([...new Set(fixture.bearerTokens())], [PROVIDER_TOKEN]);
    const toModel = JSON.stringify(h.model.requests.map((r) => r.body));
    assert.ok(
      !toModel.includes(PROVIDER_TOKEN),
      "provider token never reaches the model",
    );
  });

  // Assumption 3, policy half: a gateway-side filter and refusal hold even
  // when Codex was told nothing about them.
  test("a tool the gateway blocks is not offered, and a forced call is refused", async () => {
    fixture.reset();
    gateway.reset();
    gateway.blocked = new Set(["list_unlabelled"]);
    h.model.script.length = 0;
    h.model.script.push({
      kind: "call",
      name: "list_unlabelled",
      namespace: NAMESPACE,
      args: {},
    });
    h.model.script.push({ kind: "reply", text: "refused" });
    const body = h.body({ chatId: "gw2", mcp: spec(gateway) });
    // The model fixture keeps requests across tests; read only this run's.
    const firstOfRun = h.model.requests.length;
    const { events } = await runAnswering(h, body, () => "allow");

    const offered = JSON.stringify(h.model.requests[firstOfRun]!.body.tools);
    assert.ok(offered.includes("get_issue"));
    assert.ok(!offered.includes("list_unlabelled"), "filtered from tools/list");
    assert.equal(fixture.toolCalls(), 0, "provider never called");
    assert.equal(completed(events).status, "completed");
    console.log(
      "[probe] blocked call:",
      JSON.stringify(of(events, "tool.completed")),
    );
    console.log(
      "[probe] model saw:",
      JSON.stringify(h.model.lastRequest().body.input).slice(-400),
    );
  });

  // Server-side approvals: Codex was allowed to call the write tool (the
  // member clicked Allow), but the gateway has no approval record and refuses.
  test("a write Codex approved but the gateway refuses fails cleanly", async () => {
    fixture.reset();
    gateway.reset();
    gateway.refusedOnCall = new Set(["create_issue"]);
    h.model.script.length = 0;
    h.model.script.push({
      kind: "call",
      name: "create_issue",
      namespace: NAMESPACE,
      args: { title: "no record" },
    });
    h.model.script.push({ kind: "reply", text: "refused" });
    const body = h.body({ chatId: "gw2b", mcp: spec(gateway) });
    const { events } = await runAnswering(h, body, () => "allow");

    assert.equal(fixture.toolCalls(), 0, "provider never called");
    assert.equal(completed(events).status, "completed");
    const done = of(events, "tool.completed")[0]!;
    console.log("[probe] gateway-refused write:", JSON.stringify(done));
    assert.equal(done.status, "failed");
    const toModel = JSON.stringify(h.model.lastRequest().body.input);
    assert.ok(
      toModel.includes("not allowed in this chat"),
      "the model sees the gateway's reason",
    );
  });

  // Assumption 1: if the gateway held a call while a person decides, Codex's
  // per-call tool timeout is the ceiling, not the approval timer.
  test("a call held past tool_timeout_sec fails; within it, succeeds", async () => {
    for (const [timeoutSec, holdMs] of [
      [3, 6000],
      [10, 6000],
    ] as const) {
      fixture.reset();
      gateway.reset();
      gateway.holdMs = holdMs;
      h.model.script.length = 0;
      h.model.script.push({
        kind: "call",
        name: "get_issue",
        namespace: NAMESPACE,
        args: { number: 2 },
      });
      h.model.script.push({ kind: "reply", text: "after hold" });
      const started = Date.now();
      const { events } = await runAnswering(
        h,
        h.body({
          chatId: `gw3_${timeoutSec}`,
          mcp: spec(gateway, TRUEX_TOKEN, timeoutSec),
        }),
        () => "allow",
      );
      const done = of(events, "tool.completed")[0]!;
      console.log(
        `[probe] timeout=${timeoutSec}s hold=${holdMs}ms ->`,
        done.status,
        done.errorCode ?? "",
        `${Date.now() - started}ms`,
      );
      assert.equal(completed(events).status, "completed");
      assert.equal(
        done.status,
        timeoutSec * 1000 > holdMs ? "completed" : "failed",
      );
    }
  });

  // Assumption 2: a per-chat token reused across runs does not reload the
  // thread; a new token per run does.
  test("same token across runs keeps the thread loaded; a new token reloads it", async () => {
    const reloads = () => h.logs.filter((l) => l.event === "mcp_reload").length;
    const runOnce = async (threadId: string | null, token: string) => {
      fixture.reset();
      gateway.reset();
      h.model.script.length = 0;
      h.model.script.push({
        kind: "call",
        name: "get_issue",
        namespace: NAMESPACE,
        args: { number: 3 },
      });
      h.model.script.push({ kind: "reply", text: "ok" });
      const { events } = await runAnswering(
        h,
        h.body({ chatId: "gw4", threadId, mcp: spec(gateway, token) }),
        () => "allow",
      );
      const accepted = events.find((e) => e.type === "run.accepted")!.data;
      return { events, accepted };
    };

    const first = await runOnce(null, TRUEX_TOKEN);
    const threadId = String(first.accepted.threadId);
    const before = reloads();

    const second = await runOnce(threadId, TRUEX_TOKEN);
    assert.equal(second.accepted.resumed, false);
    assert.equal(reloads(), before, "same per-chat token: no reload");

    // A per-run token: the gateway would accept it; here it is simply new.
    const third = await runOnce(threadId, "TRUEX_CALLER_run_token_other");
    assert.equal(reloads(), before + 1, "new token: process reload");
    assert.equal(third.accepted.resumed, true);
    console.log(
      "[probe] new-token run tool:",
      JSON.stringify(of(third.events, "tool.completed")),
    );
  });
});
