import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentCoreBridge,
  type AgentCoreBridge,
} from "../../src/agentcore/bridge";
import {
  agentCoreSessionId,
  SESSION_HEADER,
} from "../../src/agentcore/session";
import { loadConfig } from "../../src/config";

// Runs the AgentCore bridge (RUNTIME_MODE=agentcore) on loopback in a
// throwaway state directory, and calls it the way InvokeAgentRuntime does.

export interface Envelope {
  readonly status: number;
  readonly body: {
    readonly error?: { readonly code: string; readonly details?: unknown };
  } & Record<string, unknown>;
}

export class BridgeHarness {
  bridge!: AgentCoreBridge;
  stateDir = "";
  base = "";
  readonly logs: Array<{ event: string; fields: Record<string, unknown> }> = [];

  // `env` adds to the agentcore configuration (RUNTIME_CODEX_BINARY,
  // RUNTIME_CODING_ENABLED...).
  constructor(private readonly env: Record<string, string> = {}) {}

  async start(): Promise<this> {
    this.stateDir = await mkdtemp(join(tmpdir(), "runtime-adapter-agentcore-"));
    const config = loadConfig({
      RUNTIME_MODE: "agentcore",
      RUNTIME_STATE_DIR: this.stateDir,
      ...this.env,
    });
    this.bridge = createAgentCoreBridge(config, (event, fields) =>
      this.logs.push({ event, fields }),
    );
    this.bridge.server.listen(0, "127.0.0.1");
    await once(this.bridge.server, "listening");
    const address = this.bridge.server.address() as { port: number };
    this.base = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close(): Promise<void> {
    await this.bridge.shutdown();
    await rm(this.stateDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }

  // `session` defaults to the chat's own session ID; null sends none.
  invoke(
    invocation: unknown,
    chat = { tenantId: "tenant1", chatId: "chat1" },
    session: string | null = agentCoreSessionId(chat.tenantId, chat.chatId),
  ): Promise<Response> {
    return fetch(`${this.base}/invocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session === null ? {} : { [SESSION_HEADER]: session }),
      },
      body: JSON.stringify(invocation),
    });
  }

  async ping(): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.base}/ping`);
    return { status: res.status, body: await res.json() };
  }

  count(event: string): number {
    return this.logs.filter((l) => l.event === event).length;
  }
}

// Non-stream answers are always HTTP 200 carrying the adapter's own status.
export async function envelope(res: Response): Promise<Envelope> {
  if (res.status !== 200)
    throw new Error(`expected an envelope, got HTTP ${res.status}`);
  if (!res.headers.get("content-type")?.startsWith("application/json"))
    throw new Error(`expected JSON, got ${res.headers.get("content-type")}`);
  return (await res.json()) as Envelope;
}
