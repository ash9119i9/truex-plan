import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  protectMessage,
  ResultTooLargeError,
  rewriteSse,
  UNTRUSTED_META,
} from "../src/results";

// Task 11: what a provider sends back is cleaned before Codex sees it.

const ACCESS = "gho_provider_token_abc123";
const REFRESH = "ghr_provider_refresh_xyz789";
const CAP = 64 * 1024;

type Message = {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    _meta?: Record<string, unknown>;
  };
  error?: { message: string };
};

describe("tool results", () => {
  test("known token values are redacted from results and errors", () => {
    const result = protectMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: `token=${ACCESS} and ${REFRESH}` }],
          structuredContent: { nested: { deep: [ACCESS] } },
        },
      },
      [ACCESS, REFRESH],
      CAP,
    );
    const text = JSON.stringify(result.message);
    assert.ok(!text.includes(ACCESS) && !text.includes(REFRESH));
    assert.match(text, /token=\[redacted\] and \[redacted\]/);
    assert.equal(result.redacted, true);

    const error = protectMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: `bad header Bearer ${ACCESS}` },
      },
      [ACCESS],
      CAP,
    );
    assert.equal(
      (error.message as Message).error?.message,
      "bad header Bearer [redacted]",
    );
  });

  test("results are marked untrusted, keeping the provider's _meta", () => {
    const { message } = protectMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [], _meta: { "vendor/trace": "t1" } },
      },
      [],
      CAP,
    );
    assert.deepEqual((message as Message).result?._meta, {
      "vendor/trace": "t1",
      [UNTRUSTED_META]: true,
    });
    // An error or a notification has no result to mark.
    const error = protectMessage(
      { jsonrpc: "2.0", id: 2, error: { code: 1, message: "no" } },
      [],
      CAP,
    );
    assert.equal((error.message as Message).result, undefined);
  });

  test("an oversized result is cut to the cap with a visible note", () => {
    const max = 2048;
    const out = protectMessage(
      {
        jsonrpc: "2.0",
        id: 9,
        result: {
          content: [
            { type: "text", text: "first part" },
            { type: "text", text: "x".repeat(10_000) },
            { type: "text", text: "never reached" },
          ],
        },
      },
      [],
      max,
    );
    assert.equal(out.truncated, true);
    const text = JSON.stringify(out.message);
    assert.ok(Buffer.byteLength(text) <= max, String(Buffer.byteLength(text)));
    const content = (out.message as Message).result?.content ?? [];
    assert.equal(content[0]?.text, "first part");
    assert.match(content.at(-1)?.text ?? "", /cut by the Truex gateway/);
    assert.ok(!text.includes("never reached"));
    assert.equal((out.message as { id: number }).id, 9);
  });

  test("empty or very short secrets are ignored", () => {
    const out = protectMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "a normal answer" }] },
      },
      ["", "ab"],
      CAP,
    );
    assert.equal(out.redacted, false);
    assert.equal(
      (out.message as Message).result?.content?.[0]?.text,
      "a normal answer",
    );
  });
});

describe("SSE rewriting", () => {
  async function* chunksOf(text: string, cuts: number[]) {
    const encoder = new TextEncoder();
    let start = 0;
    for (const cut of [...cuts, text.length]) {
      yield encoder.encode(text.slice(start, cut));
      start = cut;
    }
  }

  test("rewrites each message, across chunk boundaries", async () => {
    const raw =
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"note":"${ACCESS}"}}\n\n` +
      `event: message\r\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"${ACCESS}"}]}}\r\n\r\n`;
    const out: string[] = [];
    for await (const event of rewriteSse(
      chunksOf(raw, [17, 90, 140]),
      (m) => protectMessage(m, [ACCESS], CAP).message,
      CAP,
    ))
      out.push(event);
    assert.equal(out.length, 2);
    for (const event of out) {
      assert.match(event, /^event: message\ndata: .*\n\n$/s);
      assert.ok(!event.includes(ACCESS));
    }
    const last = JSON.parse(
      out[1]!.slice(out[1]!.indexOf("data: ") + 6),
    ) as Message;
    assert.equal(last.result?._meta?.[UNTRUSTED_META], true);
  });

  test("an event larger than the limit stops the stream", async () => {
    const raw = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "x", params: { pad: "y".repeat(5000) } })}\n\n`;
    await assert.rejects(async () => {
      for await (const _ of rewriteSse(chunksOf(raw, [100]), (m) => m, 1024));
    }, ResultTooLargeError);
  });
});
