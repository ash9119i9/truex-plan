import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sdkStreamMixin } from "@smithy/core/serde";
import { RuntimeTransport } from "../src/runtime/transport";

const arn =
  "arn:aws:bedrock-agentcore:us-east-1:502055890667:runtime/test_runtime";

test("both runtime transports reject invalid operational preferences before dispatch", async (t) => {
  let httpCalls = 0,
    sdkCalls = 0;
  const server = createServer((_req, res) => {
    httpCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const owner = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new RuntimeTransport(async () => {
    sdkCalls++;
    return {
      $metadata: {},
      response: sdkStreamMixin(
        Readable.from([Buffer.from('{"status":200,"body":{}}')], {
          objectMode: false,
        }),
      ),
      contentType: "application/json",
    };
  });
  for (const runtime of [owner, arn])
    for (const response of [null, true, false, "full", 0, {}, []])
      await assert.rejects(
        transport.request({
          owner: runtime,
          sessionId: randomUUID(),
          path: "/threads/t/resume",
          method: "POST",
          body: { response },
        }),
        { status: 400, code: "INVALID_INPUT" },
      );
  assert.equal(httpCalls, 0);
  assert.equal(sdkCalls, 0);
});

test("operational preference stays in the AgentCore body and default resume is untouched", async () => {
  const calls: any[] = [];
  const transport = new RuntimeTransport(async (_region, command) => {
    calls.push(
      JSON.parse(Buffer.from(command.input.payload as Uint8Array).toString()),
    );
    return {
      $metadata: {},
      response: sdkStreamMixin(
        Readable.from([Buffer.from('{"status":200,"body":{}}')], {
          objectMode: false,
        }),
      ),
      contentType: "application/json",
    };
  });
  for (const body of [
    { response: "operational", approvalMode: "ask" },
    { approvalMode: "readOnly" },
  ]) {
    await transport.request({
      owner: arn,
      sessionId: randomUUID(),
      path: "/threads/t/resume",
      method: "POST",
      body,
    });
    assert.deepEqual(calls.at(-1).body, body);
  }
});
