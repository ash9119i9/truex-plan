import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { createGateway } from "../../model-gateway/src/server";
import { signGatewayToken } from "../../shared/gateway-token";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runtime timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const chunk = (x: unknown) => `data: ${JSON.stringify(x)}\n\n`;
const MODEL = "gemini-3-pro-preview";

test(
  "pinned runtime through the model gateway: Gemini thoughts, signed tool calls and follow-ups",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-gateway-gemini-"));
    const requests: { key: string; url: string; body: any }[] = [];
    // A Gemini-only provider: only streamGenerateContent exists.
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      if (req.url !== `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`) {
        res.writeHead(404).end();
        return;
      }
      requests.push({
        key: String(req.headers["x-goog-api-key"]),
        url: String(req.url),
        body: JSON.parse(raw),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requests.length === 1) {
        res.write(
          chunk({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "Look up the files.", thought: true }],
                },
              },
            ],
          }),
        );
        res.write(
          chunk({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        id: "fc_files",
                        name: "conversation_files",
                        args: {},
                      },
                      thoughtSignature: "U0lHX0ZJTEVT",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          }),
        );
      } else {
        const text =
          requests.length === 2 ? "No files yet." : "Still no files.";
        for (const piece of text.split(" "))
          res.write(
            chunk({
              candidates: [
                { content: { role: "model", parts: [{ text: piece + " " }] } },
              ],
            }),
          );
        res.write(
          chunk({
            candidates: [
              { content: { role: "model", parts: [] }, finishReason: "STOP" },
            ],
          }),
        );
      }
      res.end(
        chunk({
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 3,
            totalTokenCount: 19,
          },
        }),
      );
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const secret = "g".repeat(32);
    const gateway = createGateway({
      secret,
      findProfile: async (id) =>
        id === "gemprofile"
          ? {
              _id: id,
              baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1beta`,
              modelName: MODEL,
              wireApi: "gemini",
              apiKey: "real-gemini-key",
            }
          : null,
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    const client = new BusinessRuntime(binary, home, 15000),
      manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      for (const s of [provider, gateway]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const { threadId } = await manager.create({
      model: MODEL,
      modelProvider: "profile_gemprofile",
      config: {
        web_search: "disabled",
        "model_providers.profile_gemprofile": {
          name: "Gemini",
          base_url: `http://127.0.0.1:${(gateway.address() as any).port}/p/gemprofile/v1`,
          wire_api: "responses",
          experimental_bearer_token: signGatewayToken("gemprofile", secret),
        },
      },
    });
    await manager.message(threadId, "Which files do I have?");
    await until(
      () =>
        manager.snapshot(threadId).state.kind === "idle" &&
        requests.length >= 2,
    );
    await manager.message(threadId, "And now?");
    await until(
      () =>
        manager.snapshot(threadId).state.kind === "idle" &&
        requests.length >= 3,
    );

    assert.equal(requests.length, 3);
    for (const r of requests) assert.equal(r.key, "real-gemini-key");
    const first = requests[0].body;
    assert.ok(first.systemInstruction?.parts?.[0]?.text);
    assert.equal(first.contents[0].role, "user");
    const names = first.tools[0].functionDeclarations.map((d: any) => d.name);
    assert.ok(names.includes("conversation_files"));
    assert.ok(names.every((n: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));
    assert.equal(first.generationConfig.thinkingConfig.includeThoughts, true);

    // Codex ran the tool; the call went back signed, followed by its result.
    const second: any[] = requests[1].body.contents;
    const callIndex = second.findIndex((c) =>
      c.parts.some((p: any) => p.functionCall),
    );
    assert.ok(callIndex > 0);
    const callPart = second[callIndex].parts.find((p: any) => p.functionCall);
    assert.equal(second[callIndex].role, "model");
    assert.equal(callPart.functionCall.name, "conversation_files");
    assert.equal(callPart.functionCall.id, "fc_files");
    assert.equal(callPart.thoughtSignature, "U0lHX0ZJTEVT");
    const result = second[callIndex + 1];
    assert.equal(result.role, "user");
    assert.equal(result.parts[0].functionResponse.name, "conversation_files");
    assert.equal(result.parts[0].functionResponse.id, "fc_files");
    // Roles alternate: consecutive same-role contents were merged.
    for (let i = 1; i < second.length; i++)
      assert.notEqual(second[i].role, second[i - 1].role);

    // The follow-up carries the whole conversation, signature included.
    const third = JSON.stringify(requests[2].body.contents);
    assert.match(third, /No files yet\./);
    assert.match(third, /And now\?/);
    assert.match(third, /U0lHX0ZJTEVT/);
    assert.doesNotMatch(third, /Look up the files\./);
    const messages = manager.snapshot(threadId).messages;
    assert.match(JSON.stringify(messages), /Still no files\./);
    assert.equal(manager.snapshot(threadId).pending.length, 0);
  },
);
