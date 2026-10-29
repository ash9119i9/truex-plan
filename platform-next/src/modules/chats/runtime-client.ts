// The platform's side of the runtime adapter contract
// (runtime-adapter/README.md). Plain HTTP today; the AgentCore transport wraps
// the same operations.

import type { McpServerSpec } from "../connectors/mcp-server-spec";
import type { RunNetworkPolicy } from "../network/network-policy";

// A skill version a run uses, by its archive's digest and its folder name.
// The archive is pushed first (putSkill); the adapter refuses a run whose
// skills it does not hold with SKILLS_MISSING.
export interface RunSkill {
  readonly sha256: string;
  readonly slug: string;
}

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
  readonly input: {
    readonly text: string;
    readonly clientMessageId: string;
    // `uploads/<name>` paths of attached images, shown to the model as
    // images. Present only when the message has some.
    readonly images?: readonly string[];
  };
  readonly agentPrompt: string;
  // The directory-connector MCP servers for this turn, included only when
  // non-empty. Carries per-user Authorization headers, so it is NEVER logged.
  readonly mcp?: readonly McpServerSpec[];
  // What sandbox commands may reach (CHAT_SANDBOX_NETWORK=1 only). Carries
  // the members' connector tokens, so it is NEVER logged.
  readonly network?: RunNetworkPolicy;
  // Coding Allow-for-this-chat answers: command scopes.
  readonly codingApprovals?: {
    readonly commands: readonly string[];
  };
  // The chat's skills, the same list on every run. Included only when
  // non-empty.
  readonly skills?: readonly RunSkill[];
  // Helper agents (CHAT_SUBAGENTS only): how many may run at once.
  readonly subAgents?: { readonly maxConcurrent: number };
  // The chat's goal setting, snapshotted when the chat was created. Absent
  // for a chat without goals.
  readonly goals?: GoalSettings;
  readonly model: {
    readonly modelName: string;
    readonly gatewayUrl: string;
    readonly gatewayToken: string;
    readonly contextWindow: number;
    readonly autoCompactTokenLimit: number;
    readonly reasoningEffort?: string;
  };
}

export interface GoalSettings {
  readonly maxTokenBudget: number;
}

// Codex's goal statuses. The member sets only active and paused.
export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// The chat's goal as Codex reports it. Times are Unix seconds.
export interface RuntimeGoal {
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// `user`: set through the goal API; `model`: the model created it.
export type GoalOrigin = "user" | "model";

export interface GoalUpdate {
  readonly goal: RuntimeGoal;
  // The turn it changed in, or null outside a turn.
  readonly turnId: string | null;
  readonly origin: GoalOrigin;
}

// What making a goal active needs to start or resume the chat's thread:
// the run body without its own ID, input and goals.
export type GoalRunContext = Omit<
  StartRunBody,
  "runId" | "tenantId" | "chatId" | "input" | "goals"
>;

export type GoalSetBody = {
  readonly goals: GoalSettings;
  readonly objective?: string;
  readonly tokenBudget?: number;
} & (
  | { readonly status: "active"; readonly run: GoalRunContext }
  | { readonly status: "paused"; readonly run?: never }
);

// A run in progress in the chat, as a chat snapshot names it.
export interface ActiveRuntimeRun {
  readonly runId: string;
  // null while Codex has not yet accepted a member's run.
  readonly turnId: string | null;
  readonly trigger: "user" | "goal";
}

// Where to resume a chat stream: the `streamId` of its last snapshot and the
// last seq read after it.
export interface ChatCursor {
  readonly streamId: string;
  readonly seq: number;
}

// The chat stream's events, parsed. Anything else is dropped.
export type ChatEvent =
  | ({ readonly seq: number; readonly type: "goal.updated" } & GoalUpdate)
  | { readonly seq: number; readonly type: "goal.cleared" }
  | {
      readonly seq: number;
      readonly type: "run.started";
      readonly runId: string;
      readonly turnId: string;
      readonly trigger: "goal";
    }
  | {
      readonly seq: number;
      readonly type: "chat.snapshot";
      // Names the stream's numbering; reconnect with it (ChatCursor).
      readonly streamId: string;
      readonly goal: RuntimeGoal | null;
      readonly origin: GoalOrigin | null;
      readonly activeRun: ActiveRuntimeRun | null;
    };

// A visible file in the chat's runtime workspace.
export interface WorkspaceFile {
  // Workspace-relative, "/"-separated.
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

// The adapter's per-file read limit.
export const MAX_WORKSPACE_FILE_BYTES = 20 * 1024 * 1024;

// The adapter answered with an error. `code` is the adapter's code.
export class AdapterRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    // The adapter's machine-readable fields (SKILLS_MISSING: `missing`).
    readonly details?: Readonly<Record<string, unknown>>,
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
// One attached file (at most 20 MiB) into the runtime.
const UPLOAD_TIMEOUT_MS = 120_000;
// One skill archive (at most 5 MB).
const SKILL_TIMEOUT_MS = 60_000;

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

  // Sets the chat's goal. Making it active may start or resume the thread
  // first, so it gets the cold-start allowance. Refusals are AdapterRefusal.
  async setGoal(ref: ChatRef, body: GoalSetBody): Promise<RuntimeGoal> {
    const answer = (await this.json(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/goal`,
      "PUT",
      { tenantId: ref.tenantId, ...body },
      this.timeouts.headersMs,
    )) as { goal?: unknown };
    const goal = runtimeGoal(answer.goal);
    if (!goal) throw new AdapterUnreachable("invalid goal response");
    return goal;
  }

  async getGoal(ref: ChatRef): Promise<RuntimeGoal | null> {
    const query = new URLSearchParams({ tenantId: ref.tenantId });
    const answer = (await this.json(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/goal?${query}`,
      "GET",
    )) as { goal?: unknown };
    if (answer.goal === null) return null;
    const goal = runtimeGoal(answer.goal);
    if (!goal) throw new AdapterUnreachable("invalid goal response");
    return goal;
  }

  // Resolves whether there was a goal to clear.
  async clearGoal(ref: ChatRef): Promise<boolean> {
    const query = new URLSearchParams({ tenantId: ref.tenantId });
    const answer = (await this.json(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/goal?${query}`,
      "DELETE",
    )) as { cleared?: unknown };
    if (typeof answer.cleared !== "boolean")
      throw new AdapterUnreachable("invalid clear response");
    return answer.cleared;
  }

  // The chat stream after `cursor`; a first read (null) or a cursor the
  // adapter cannot resume starts with a snapshot. It does not end by itself;
  // the caller aborts it. Malformed events are dropped.
  async *chatEvents(
    ref: ChatRef,
    cursor: ChatCursor | null,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const query = new URLSearchParams({
      tenantId: ref.tenantId,
      after: String(cursor?.seq ?? 0),
      ...(cursor && { streamId: cursor.streamId }),
    });
    for await (const event of this.stream(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/events?${query}`,
      { method: "GET" },
      signal,
    )) {
      const parsed = chatEvent(event);
      if (parsed) yield parsed;
    }
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

  // The chat's workspace files, for copying a run's output into storage.
  async files(
    ref: ChatRef,
  ): Promise<{ files: WorkspaceFile[]; truncated: boolean }> {
    const query = new URLSearchParams({ tenantId: ref.tenantId });
    const body = (await this.json(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/files?${query}`,
      "GET",
    )) as { files?: unknown; truncated?: unknown };
    if (!Array.isArray(body.files))
      throw new AdapterUnreachable("invalid files response");
    return {
      files: body.files.filter(isWorkspaceFile),
      truncated: body.truncated === true,
    };
  }

  // One workspace file's bytes. Refusals are AdapterRefusal (FILE_NOT_FOUND,
  // PAYLOAD_TOO_LARGE).
  async file(ref: ChatRef, path: string): Promise<Buffer> {
    const query = new URLSearchParams({ tenantId: ref.tenantId, path });
    const res = await this.send(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/file?${query}`,
      "GET",
      undefined,
      AbortSignal.timeout(this.timeouts.requestMs),
    );
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_WORKSPACE_FILE_BYTES)
      throw new AdapterUnreachable("file too large");
    let data: Buffer;
    try {
      data = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      throw new AdapterUnreachable(
        error instanceof Error ? error.name : "read failed",
      );
    }
    if (data.length > MAX_WORKSPACE_FILE_BYTES)
      throw new AdapterUnreachable("file too large");
    return data;
  }

  // Writes an attached file to `uploads/<name>` in the chat's workspace, for
  // the run about to start. Refusals are AdapterRefusal (UPLOADS_DISABLED,
  // UPLOAD_CONFLICT, CHAT_BUSY, ...).
  async putUpload(
    ref: ChatRef,
    name: string,
    sha256: string,
    data: Buffer,
  ): Promise<{ path: string; modifiedAt: number }> {
    const query = new URLSearchParams({ tenantId: ref.tenantId, sha256 });
    const res = await this.send(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/uploads/${encodeURIComponent(name)}?${query}`,
      "PUT",
      data,
      AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    );
    let body: { path?: unknown; modifiedAt?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new AdapterUnreachable("invalid upload response");
    }
    if (typeof body.path !== "string" || !Number.isSafeInteger(body.modifiedAt))
      throw new AdapterUnreachable("invalid upload response");
    return { path: body.path, modifiedAt: body.modifiedAt as number };
  }

  // Unpacks one skill archive in the chat's runtime, before a run that names
  // it. Repeating it for a digest the runtime holds changes nothing.
  async putSkill(ref: ChatRef, sha256: string, data: Buffer): Promise<void> {
    const query = new URLSearchParams({ tenantId: ref.tenantId });
    await this.send(
      `/v1/chats/${encodeURIComponent(ref.chatId)}/skills/${encodeURIComponent(sha256)}?${query}`,
      "PUT",
      data,
      AbortSignal.timeout(SKILL_TIMEOUT_MS),
      "application/gzip",
    );
  }

  private async json(
    path: string,
    method: string,
    body?: unknown,
    timeoutMs = this.timeouts.requestMs,
  ) {
    const res = await this.send(
      path,
      method,
      body,
      AbortSignal.timeout(timeoutMs),
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
    contentType?: string,
  ): Promise<Response> {
    let res: Response;
    try {
      const raw = Buffer.isBuffer(body);
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined
            ? {}
            : {
                "content-type":
                  contentType ??
                  (raw ? "application/octet-stream" : "application/json"),
              }),
        },
        body:
          body === undefined
            ? undefined
            : raw
              ? new Uint8Array(body)
              : JSON.stringify(body),
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
      error?: { code?: unknown; retryable?: unknown; details?: unknown };
    };
    if (typeof body.error?.code === "string") {
      const details = body.error.details;
      return new AdapterRefusal(
        res.status,
        body.error.code,
        body.error.retryable === true,
        details && typeof details === "object" && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : undefined,
      );
    }
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

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === "string" &&
    file.path.length > 0 &&
    file.path.length <= 1024 &&
    Number.isSafeInteger(file.size) &&
    (file.size as number) >= 0 &&
    Number.isSafeInteger(file.modifiedAt)
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

// Codex's turn IDs are UUIDs; anything short and non-empty is accepted.
const isTurnId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
// Run IDs are ObjectIds: the platform's own, and a goal run's
// (runtime-adapter goalRunId) is ObjectId-shaped.
const RUN_ID = /^[0-9a-f]{24}$/;
// The adapter's ID rule, which it applies to a `streamId` sent back.
const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function runtimeGoal(value: unknown): RuntimeGoal | null {
  if (!value || typeof value !== "object") return null;
  const g = value as Record<string, unknown>;
  if (
    typeof g.objective !== "string" ||
    g.objective.length === 0 ||
    !GOAL_STATUSES.includes(g.status as GoalStatus) ||
    !(
      g.tokenBudget === null ||
      (count(g.tokenBudget) && (g.tokenBudget as number) > 0)
    ) ||
    !count(g.tokensUsed) ||
    !count(g.timeUsedSeconds) ||
    !count(g.createdAt) ||
    !count(g.updatedAt)
  )
    return null;
  return {
    objective: g.objective,
    status: g.status as GoalStatus,
    tokenBudget: g.tokenBudget as number | null,
    tokensUsed: g.tokensUsed as number,
    timeUsedSeconds: g.timeUsedSeconds as number,
    createdAt: g.createdAt as number,
    updatedAt: g.updatedAt as number,
  };
}

const isOrigin = (value: unknown): value is GoalOrigin =>
  value === "user" || value === "model";

// A goal.updated event's data, from the chat stream or a run's stream.
export function goalUpdate(data: Record<string, unknown>): GoalUpdate | null {
  const goal = runtimeGoal(data.goal);
  if (!goal || !isOrigin(data.origin)) return null;
  if (data.turnId !== null && !isTurnId(data.turnId)) return null;
  return { goal, turnId: data.turnId, origin: data.origin };
}

// null: no run in progress; undefined: malformed.
function activeRun(value: unknown): ActiveRuntimeRun | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r.runId !== "string" ||
    !RUN_ID.test(r.runId) ||
    (r.turnId !== null && !isTurnId(r.turnId)) ||
    (r.trigger !== "user" && r.trigger !== "goal")
  )
    return undefined;
  return { runId: r.runId, turnId: r.turnId, trigger: r.trigger };
}

function chatEvent(event: AdapterEvent): ChatEvent | null {
  const { seq, data } = event;
  switch (event.type) {
    case "goal.updated": {
      const update = goalUpdate(data);
      return update && { seq, type: "goal.updated", ...update };
    }
    case "goal.cleared":
      return { seq, type: "goal.cleared" };
    case "run.started":
      if (
        typeof data.runId !== "string" ||
        !RUN_ID.test(data.runId) ||
        !isTurnId(data.turnId) ||
        data.trigger !== "goal"
      )
        return null;
      return {
        seq,
        type: "run.started",
        runId: data.runId,
        turnId: data.turnId,
        trigger: "goal",
      };
    case "chat.snapshot": {
      const { streamId } = data;
      if (typeof streamId !== "string" || !STREAM_ID.test(streamId))
        return null;
      const run = activeRun(data.activeRun);
      if (run === undefined) return null;
      if (data.goal === null)
        return data.origin === null
          ? {
              seq,
              type: "chat.snapshot",
              streamId,
              goal: null,
              origin: null,
              activeRun: run,
            }
          : null;
      const goal = runtimeGoal(data.goal);
      if (!goal || !isOrigin(data.origin)) return null;
      return {
        seq,
        type: "chat.snapshot",
        streamId,
        goal,
        origin: data.origin,
        activeRun: run,
      };
    }
    default:
      return null;
  }
}
