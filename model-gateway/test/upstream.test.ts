import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGateway } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";

const secret = "t".repeat(32);
const listen = (s: any) =>
  new Promise<number>((r) =>
    s.listen(0, "127.0.0.1", () => r(s.address().port)),
  );
const chunk = (x: unknown) => `data: ${JSON.stringify(x)}\n\n`;
const body = JSON.stringify({
  model: "m",
  stream: true,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ],
});

async function run(
  provider: (req: any, res: any) => void,
  timeouts: {
    upstreamFirstByteTimeoutMs?: number;
    upstreamIdleTimeoutMs?: number;
  },
  profileExtra: Record<string, unknown> = {},
) {
  const up = createServer(provider);
  const upPort = await listen(up);
  const logs: string[] = [];
  const gw = createGateway({
    secret,
    log: (l) => logs.push(l),
    findProfile: async () => ({
      _id: "p",
      baseUrl: `http://127.0.0.1:${upPort}/v1`,
      modelName: "m",
      wireApi: "chat",
      apiKey: "k",
      ...profileExtra,
    }),
    ...timeouts,
  });
  const port = await listen(gw);
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/p/p/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${signGatewayToken("p", secret)}` },
    body,
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  for (const s of [gw, up]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  return { status: res.status, text, ms, logs };
}

test("upstream: no response headers in time -> 504 that Codex retries", async () => {
  const r = await run(() => {}, { upstreamFirstByteTimeoutMs: 150 });
  assert.equal(r.status, 504);
  assert.match(r.text, /"code":"server_error"/);
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  assert.match(r.logs.join("\n"), /upstream timed out/);
});

test("upstream: stalls mid-stream -> failed stream instead of hanging", async () => {
  const r = await run(
    (req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(chunk({ choices: [{ delta: { content: "partial" } }] }));
      // ...then silence.
    },
    { upstreamIdleTimeoutMs: 150 },
  );
  assert.equal(r.status, 200);
  assert.match(r.text, /response\.failed/);
  assert.match(r.text, /"code":"server_error"/);
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
});

test("upstream: a slow but steady stream is not cut off", async () => {
  const r = await run(
    async (req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const w of ["a ", "b ", "c ", "d "]) {
        await new Promise((x) => setTimeout(x, 100));
        res.write(chunk({ choices: [{ delta: { content: w } }] }));
      }
      res.write(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.end("data: [DONE]\n\n");
    },
    { upstreamFirstByteTimeoutMs: 150, upstreamIdleTimeoutMs: 150 },
  );
  // Total 400ms+ exceeds both limits, but no single wait does.
  assert.equal(r.status, 200);
  assert.match(r.text, /response\.completed/);
  assert.doesNotMatch(r.text, /response\.failed/);
});

// The pattern measured on NVIDIA's hosted API: headers at once, then silence.
const queued = (req: any, res: any) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.flushHeaders();
};

test("upstream: headers arrive but no data -> times out at first byte, retryable", async () => {
  const r = await run(queued, {
    upstreamFirstByteTimeoutMs: 150,
    upstreamIdleTimeoutMs: 10_000,
  });
  // Upstream already said 200, so the gateway ends with a failed stream,
  // which Codex retries.
  assert.equal(r.status, 200);
  assert.match(r.text, /response\.failed/);
  assert.match(r.text, /"code":"server_error"/);
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
  assert.match(
    r.logs.join("\n"),
    /no response from the model provider within 150ms/,
  );
});

test("upstream: a profile's firstByteTimeoutMs overrides the gateway default", async () => {
  const r = await run(
    queued,
    { upstreamFirstByteTimeoutMs: 60_000 },
    { firstByteTimeoutMs: 150 },
  );
  assert.match(r.text, /response\.failed/);
  assert.ok(r.ms < 2000, `took ${r.ms}ms`);
});
