import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIMITS,
  loadConfig,
  type RuntimeLimits,
} from "../../src/config";
import { RuntimeManager } from "../../src/runtime/manager";
import { createAdapterServer } from "../../src/server";
import { ModelFixture } from "./model-fixture";

// Runs the real adapter (real HTTP, real pinned Codex) against the loopback
// model fixture in a throwaway state directory.

export const TOKEN = "test-adapter-token-0123456789abcdefghij";

export interface SseEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface HarnessOptions {
  readonly limits?: Partial<RuntimeLimits>;
  readonly maxProcesses?: number;
  readonly stateDir?: string;
  // Lets a test attach an http loopback MCP fixture (the only transport a test
  // can host). Off by default, so non-MCP tests keep production's https-only
  // posture.
  readonly allowLoopbackMcp?: boolean;
  // Turns the coding profile on (RUNTIME_CODING_ENABLED=1).
  readonly coding?: boolean;
  // RUNTIME_TOOLCHAIN_DIRS.
  readonly toolchainDirs?: readonly string[];
  // With coding: the network proxy forwards to this loopback stand-in for
  // the internet instead of the real hosts (network-fixture.ts).
  readonly networkEnv?: () => Readonly<Record<string, string>>;
}

export class Harness {
  readonly model = new ModelFixture();
  manager!: RuntimeManager;
  stateDir = "";
  base = "";
  readonly logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  private server!: Server;
  private ownsState = false;

  constructor(private readonly options: HarnessOptions = {}) {}

  async start(): Promise<this> {
    await this.model.start();
    if (this.options.stateDir) this.stateDir = this.options.stateDir;
    else {
      this.stateDir = await mkdtemp(join(tmpdir(), "runtime-adapter-test-"));
      this.ownsState = true;
    }
    await this.listen();
    return this;
  }

  // Simulates an adapter restart: same state directory, fresh manager and
  // Codex processes.
  async restart(): Promise<void> {
    await this.stopServer();
    await this.listen();
  }

  async close(): Promise<void> {
    await this.stopServer();
    await this.model.close();
    if (this.ownsState)
      // Retried: a git child Codex spawned (plugin sync) can still be
      // writing under the home directory for a moment after Codex exits.
      await rm(this.stateDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
  }

  body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      runId: `run_${randomUUID()}`,
      tenantId: "tenant1",
      chatId: "chat1",
      threadId: null,
      input: { text: "hello", clientMessageId: `msg_${randomUUID()}` },
      agentPrompt: "AGENT_PROMPT_MARKER You are a helpful assistant.",
      model: {
        modelName: "fixture-model",
        gatewayUrl: this.model.url,
        gatewayToken: this.model.token,
        contextWindow: 100_000,
        autoCompactTokenLimit: 80_000,
      },
      ...overrides,
    };
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("authorization"))
      headers.set("authorization", `Bearer ${TOKEN}`);
    if (init.body && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    return fetch(`${this.base}${path}`, { ...init, headers });
  }

  // Starts a run and reads its stream to the end.
  async run(body: Record<string, unknown>): Promise<SseEvent[]> {
    const res = await this.post("/v1/runs", body);
    if (res.status !== 200)
      throw new Error(`start failed: ${res.status} ${await res.text()}`);
    return readSse(res);
  }

  post(path: string, body: unknown): Promise<Response> {
    return this.fetch(path, { method: "POST", body: JSON.stringify(body) });
  }

  stop(runId: string, chat = { tenantId: "tenant1", chatId: "chat1" }) {
    return this.post(`/v1/runs/${runId}/stop`, chat);
  }

  steer(
    runId: string,
    input: { text: string; clientMessageId: string },
    chat = { tenantId: "tenant1", chatId: "chat1" },
  ) {
    return this.post(`/v1/runs/${runId}/steer`, { ...chat, input });
  }

  private async listen(): Promise<void> {
    const config = loadConfig({
      RUNTIME_ADAPTER_TOKEN: TOKEN,
      RUNTIME_STATE_DIR: this.stateDir,
      PORT: "1",
      // A worktree without its own Codex build can use another checkout's.
      ...(process.env.RUNTIME_CODEX_BINARY
        ? { RUNTIME_CODEX_BINARY: process.env.RUNTIME_CODEX_BINARY }
        : {}),
      ...(this.options.coding ? { RUNTIME_CODING_ENABLED: "1" } : {}),
      ...(this.options.toolchainDirs
        ? { RUNTIME_TOOLCHAIN_DIRS: this.options.toolchainDirs.join(":") }
        : {}),
    });
    const limits = { ...DEFAULT_LIMITS, ...this.options.limits };
    const coding =
      config.coding && this.options.networkEnv
        ? { ...config.coding, networkTestEnv: this.options.networkEnv() }
        : config.coding;
    this.manager = new RuntimeManager(
      {
        ...config,
        coding,
        limits,
        maxProcesses: this.options.maxProcesses ?? 5,
      },
      (event, fields) => this.logs.push({ event, fields }),
    );
    this.server = createAdapterServer({
      token: TOKEN,
      limits,
      manager: this.manager,
      stateDir: this.stateDir,
      log: (event, fields) => this.logs.push({ event, fields }),
      allowLoopbackMcp: this.options.allowLoopbackMcp ?? false,
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address() as { port: number };
    this.base = `http://127.0.0.1:${address.port}`;
  }

  private async stopServer(): Promise<void> {
    await this.manager.drain(0);
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// Reads an SSE response to its end, optionally invoking `onEvent` as each
// event arrives (to stop mid-stream, for example).
export async function readSse(
  res: Response,
  onEvent?: (event: SseEvent) => void | Promise<void>,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const fields: Record<string, string> = {};
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(": ");
        if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 2);
      }
      if (!fields.event) continue;
      const event = {
        seq: Number(fields.id),
        type: fields.event,
        data: JSON.parse(fields.data ?? "{}") as Record<string, unknown>,
      };
      events.push(event);
      await onEvent?.(event);
    }
  }
  return events;
}

// A run that answers each approval card as `answer` decides, as the browser
// would. `answer` may return null to leave a card unanswered.
export async function runAnswering(
  h: Harness,
  body: Record<string, unknown>,
  answer: (approval: Record<string, unknown>) => string | null,
): Promise<{ events: SseEvent[]; answers: Response[] }> {
  const answers: Response[] = [];
  const res = await h.post("/v1/runs", body);
  if (res.status !== 200)
    throw new Error(`start failed: ${res.status} ${await res.text()}`);
  const events = await readSse(res, async (event) => {
    if (event.type !== "approval.requested") return;
    const decision = answer(event.data);
    if (!decision) return;
    answers.push(
      await h.post(
        `/v1/runs/${String(body.runId)}/approvals/${String(event.data.approvalId)}`,
        { tenantId: "tenant1", chatId: body.chatId, decision },
      ),
    );
  });
  return { events, answers };
}

export function completed(events: SseEvent[]): Record<string, unknown> {
  const last = events.at(-1);
  if (last?.type !== "run.completed")
    throw new Error(
      `stream did not end with run.completed: ${JSON.stringify(events.map((e) => e.type))}`,
    );
  return last.data;
}

export function streamedText(events: SseEvent[]): string {
  return events
    .filter((e) => e.type === "text.delta")
    .map((e) => String(e.data.delta))
    .join("");
}
