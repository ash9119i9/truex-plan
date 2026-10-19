import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The chat stack for integration tests: the real runtime adapter (its own
// process, the real pinned Codex) and a loopback stand-in for the model
// gateway that speaks the Responses API. Synthetic secrets only.

export const ADAPTER_TOKEN = "test-adapter-token-0123456789abcdefghijkl";
export const GATEWAY_SECRET = "test-gateway-secret-0123456789abcdefghijk";

const ADAPTER_DIR = resolve(__dirname, "../../../runtime-adapter");

export type Behavior =
  | { kind: "reply"; text: string; chunk?: number; delayMs?: number }
  // Streams `before`, then waits for release() before the rest.
  | { kind: "held"; before: string; after: string }
  // Sends nothing, not even headers, until release(); then replies `text`.
  | { kind: "stall"; text: string }
  | { kind: "failed"; code: string };

export interface GatewayRequest {
  readonly modelId: string;
  readonly tenantId: string | undefined;
  readonly body: Record<string, unknown>;
}

// Accepts only `/p/<modelId>/v1/responses` with a token signed for that
// model, as the real gateway does.
export class FakeGateway {
  readonly requests: GatewayRequest[] = [];
  readonly script: Behavior[] = [];
  defaultBehavior: Behavior = { kind: "reply", text: "Hello from the model." };
  refused = 0;
  url = "";
  private server!: Server;
  private readonly open = new Set<ServerResponse>();
  private releases: Array<() => void> = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  // Lets every held reply finish.
  release(): void {
    const waiting = this.releases;
    this.releases = [];
    for (const resume of waiting) resume();
  }

  async close(): Promise<void> {
    this.release();
    for (const res of this.open) res.destroy();
    this.server.closeAllConnections();
    await new Promise((done) => this.server.close(done));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const match = /^\/p\/([0-9a-f]{24})\/v1\/responses$/.exec(req.url ?? "");
    const claims = verify(req.headers.authorization);
    if (!match || !claims || claims.p !== match[1]) {
      this.refused++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"message":"unauthorized"}}');
      return;
    }
    this.requests.push({
      modelId: match[1]!,
      tenantId: claims.t,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    this.open.add(res);
    res.on("close", () => this.open.delete(res));
    await this.respond(this.script.shift() ?? this.defaultBehavior, res);
  }

  private async respond(
    behavior: Behavior,
    res: ServerResponse,
  ): Promise<void> {
    const n = this.requests.length;
    if (behavior.kind === "stall") {
      await new Promise<void>((resume) => this.releases.push(resume));
      if (res.destroyed) return;
      return this.respond({ kind: "reply", text: behavior.text }, res);
    }
    const emit = (event: Record<string, unknown>) =>
      !res.destroyed &&
      res.write(
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    res.writeHead(200, { "content-type": "text/event-stream" });
    emit({ type: "response.created", response: { id: `resp_${n}` } });
    if (behavior.kind === "failed") {
      emit({
        type: "response.failed",
        response: {
          id: `resp_${n}`,
          error: { code: behavior.code, message: "provider detail" },
        },
      });
      res.end();
      return;
    }
    const itemId = `msg_${n}`;
    const text =
      behavior.kind === "held"
        ? behavior.before + behavior.after
        : behavior.text;
    emit({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", id: itemId, content: [] },
    });
    const delta = (piece: string) =>
      emit({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: piece,
      });
    if (behavior.kind === "held") {
      delta(behavior.before);
      await new Promise<void>((resume) => this.releases.push(resume));
      if (res.destroyed) return;
      delta(behavior.after);
    } else {
      const size = behavior.chunk ?? 8;
      for (let i = 0; i < text.length; i += size) {
        if (res.destroyed) return;
        delta(text.slice(i, i + size));
        if (behavior.delayMs) await sleep(behavior.delayMs);
      }
    }
    if (res.destroyed) return;
    emit({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: itemId,
        content: [{ type: "output_text", text }],
      },
    });
    emit({
      type: "response.completed",
      response: {
        id: `resp_${n}`,
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens: 10,
          total_tokens: 30,
        },
      },
    });
    res.end();
  }
}

function verify(header: string | undefined): { p: string; t?: string } | null {
  const token = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
  const [payload, signature] = token?.split(".") ?? [];
  if (!payload || !signature) return null;
  const expected = Buffer.from(
    createHmac("sha256", GATEWAY_SECRET).update(payload).digest("base64url"),
  );
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    p: string;
    t?: string;
  };
}

// The real adapter as a separate process, like production.
export class AdapterProcess {
  url = "";
  stateDir = "";
  private child: ChildProcess | undefined;
  private port = 0;

  async start(stateDir?: string): Promise<void> {
    this.stateDir ||=
      stateDir ?? (await mkdtemp(join(tmpdir(), "platform-chat-test-")));
    this.port ||= await freePort();
    this.url = `http://127.0.0.1:${this.port}`;
    this.child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: ADAPTER_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RUNTIME_ADAPTER_TOKEN: ADAPTER_TOKEN,
        RUNTIME_STATE_DIR: this.stateDir,
        HOST: "127.0.0.1",
        PORT: String(this.port),
        RUNTIME_DRAIN_MS: "1000",
      },
      stdio: "ignore",
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${this.url}/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error("adapter did not start");
      await sleep(100);
    }
  }

  // Ends the process. `hard` kills it mid-flight, losing in-memory runs.
  async stop(hard = false): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.child = undefined;
    const exited = once(child, "exit");
    child.kill(hard ? "SIGKILL" : "SIGTERM");
    await exited;
  }

  async close(): Promise<void> {
    await this.stop();
    if (this.stateDir)
      await rm(this.stateDir, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export interface StreamEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

// Reads a platform reply stream to its end.
export async function readStream(
  res: Response,
  onEvent?: (event: StreamEvent) => void | Promise<void>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let type = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7);
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!type) continue;
      const event = { type, data: JSON.parse(data) as Record<string, unknown> };
      events.push(event);
      await onEvent?.(event);
    }
  }
  return events;
}
