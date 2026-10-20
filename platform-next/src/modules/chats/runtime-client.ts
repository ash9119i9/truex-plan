// The platform's side of the runtime adapter contract
// (runtime-adapter/README.md). Plain HTTP today; the AgentCore transport wraps
// the same operations.

import type { McpServerSpec } from "../connectors/mcp-server-spec";

export interface AdapterEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface ChatRef {
  readonly tenantId: string;
  readonly chatId: string;
}

// A turn's items in the runtime's order: every input (the turn's own first)
// and every reply.
export type HistoryItem =
  | { readonly type: "input"; readonly clientMessageId: string | null }
  | { readonly type: "reply"; readonly text: string };

export interface HistoryTurn {
  readonly turnId: string;
  readonly status: string;
  readonly clientMessageId: string | null;
  readonly text: string;
  // Absent from an adapter that predates steering.
  readonly items?: readonly HistoryItem[];
}

export interface StartRunBody extends ChatRef {
  readonly runId: string;
  readonly threadId: string | null;
  readonly input: { readonly text: string; readonly clientMessageId: string };
  readonly agentPrompt: string;
  // The directory-connector MCP servers for this turn, included only when
  // non-empty. Carries per-user Authorization headers, so it is NEVER logged.
  readonly mcp?: readonly McpServerSpec[];
  readonly model: {
    readonly modelName: string;
    readonly gatewayUrl: string;
    readonly gatewayToken: string;
    readonly contextWindow: number;
    readonly autoCompactTokenLimit: number;
    readonly reasoningEffort?: string;
  };
}

// The adapter answered with an error. `code` is the adapter's code.
export class AdapterRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`runtime adapter refused: ${code}`);
    this.name = "AdapterRefusal";
  }
}

// No answer: connection failed, timed out or dropped. Whatever was sent may
// or may not have been received.
export class AdapterUnreachable extends Error {
  constructor(readonly reason: string) {
    super(`runtime adapter unreachable: ${reason}`);
    this.name = "AdapterUnreachable";
  }
}

export interface RuntimeTimeouts {
  // Until response headers; covers an AgentCore cold start.
  readonly headersMs: number;
  // Between stream chunks; the adapter writes a heartbeat every 15 s.
  readonly idleMs: number;
  // Stop and history.
  readonly requestMs: number;
}

export const DEFAULT_RUNTIME_TIMEOUTS: RuntimeTimeouts = {
  headersMs: 190_000,
  idleMs: 45_000,
  requestMs: 30_000,
};

const MAX_FRAME = 1024 * 1024;

export class RuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeouts: RuntimeTimeouts = DEFAULT_RUNTIME_TIMEOUTS,
  ) {}

  // Starts (or, for a repeated runId, attaches to) a run and yields its
  // events until run.completed or the stream ends.
  startRun(body: StartRunBody, signal: AbortSignal) {
    return this.stream("/v1/runs", { method: "POST", body }, signal);
  }

  events(runId: string, ref: ChatRef, after: number, signal: AbortSignal) {
    const query = new URLSearchParams({ ...ref, after: String(after) });
    return this.stream(
      `/v1/runs/${encodeURIComponent(runId)}/events?${query}`,
      { method: "GET" },
      signal,
    );
  }

  async stop(runId: string, ref: ChatRef): Promise<void> {
    await this.json(`/v1/runs/${encodeURIComponent(runId)}/stop`, "POST", ref);
  }

  // Adds a message to the run's running turn. Resolves once the runtime took
  // it; refusals are AdapterRefusal (RUN_ENDED, STEER_UNKNOWN, ...).
  async steer(
    runId: string,
    ref: ChatRef,
    input: { readonly text: string; readonly clientMessageId: string },
  ): Promise<void> {
    await this.json(`/v1/runs/${encodeURIComponent(runId)}/steer`, "POST", {
      ...ref,
      input,
    });
  }

  // The member's answer to a pending tool approval. Refusals are
  // AdapterRefusal (APPROVAL_RESOLVED, APPROVAL_NOT_FOUND, RUN_NOT_FOUND).
  async answerApproval(
    runId: string,
    approvalId: string,
    ref: ChatRef,
    decision: "allow" | "allow_for_chat" | "deny",
  ): Promise<void> {
    await this.json(
      `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      "POST",
      { ...ref, decision },
    );
  }

  async history(ref: ChatRef): Promise<HistoryTurn[]> {
    const query = new URLSearchParams({ tenantId: ref.tenantId });
    const body = (await this.json(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/history?${query}`,
      "GET",
    )) as { turns?: unknown };
    if (!Array.isArray(body.turns))
      throw new AdapterUnreachable("invalid history response");
    return body.turns.filter(isHistoryTurn).map((turn) => {
      const items = historyItems(turn.items);
      const { turnId, status, clientMessageId, text } = turn;
      return { turnId, status, clientMessageId, text, ...(items && { items }) };
    });
  }

  private async json(path: string, method: string, body?: unknown) {
    const res = await this.send(
      path,
      method,
      body,
      AbortSignal.timeout(this.timeouts.requestMs),
    );
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new AdapterUnreachable("invalid response body");
    }
  }

  private async send(
    path: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new AdapterUnreachable(
        error instanceof Error ? error.name : "fetch failed",
      );
    }
    if (res.ok) return res;
    throw await refusalOf(res);
  }

  private async *stream(
    path: string,
    init: { method: string; body?: unknown },
    outer: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer.addEventListener("abort", abort, { once: true });
    let timer = setTimeout(abort, this.timeouts.headersMs);
    try {
      const res = await this.send(
        path,
        init.method,
        init.body,
        controller.signal,
      );
      if (!res.body) throw new AdapterUnreachable("empty stream");
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = res.body.getReader();
      for (;;) {
        clearTimeout(timer);
        timer = setTimeout(abort, this.timeouts.idleMs);
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw new AdapterUnreachable(
            error instanceof Error ? error.name : "stream failed",
          );
        }
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MAX_FRAME)
          throw new AdapterUnreachable("stream frame too large");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (event) yield event;
        }
      }
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

function parseFrame(frame: string): AdapterEvent | null {
  const fields: Record<string, string> = {};
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(": ");
    if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 2);
  }
  if (!fields.event) return null;
  const seq = Number(fields.id);
  let data: unknown;
  try {
    data = JSON.parse(fields.data ?? "{}");
  } catch {
    throw new AdapterUnreachable("invalid event data");
  }
  if (!Number.isSafeInteger(seq) || !data || typeof data !== "object")
    throw new AdapterUnreachable("invalid event");
  return { seq, type: fields.event, data: data as Record<string, unknown> };
}

async function refusalOf(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; retryable?: unknown };
    };
    if (typeof body.error?.code === "string")
      return new AdapterRefusal(
        res.status,
        body.error.code,
        body.error.retryable === true,
      );
  } catch {
    // Not the adapter's error shape (a proxy, for example).
  }
  return res.status >= 500
    ? new AdapterUnreachable(`status ${res.status}`)
    : new AdapterRefusal(res.status, "INVALID_REQUEST", false);
}

function isHistoryTurn(value: unknown): value is HistoryTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.turnId === "string" &&
    typeof turn.status === "string" &&
    typeof turn.text === "string" &&
    (turn.clientMessageId === null || typeof turn.clientMessageId === "string")
  );
}

function historyItems(value: unknown): HistoryItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: HistoryItem[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    if (item?.type === "input")
      items.push({
        type: "input",
        clientMessageId:
          typeof item.clientMessageId === "string"
            ? item.clientMessageId
            : null,
      });
    else if (item?.type === "reply" && typeof item.text === "string")
      items.push({ type: "reply", text: item.text });
  }
  return items;
}
