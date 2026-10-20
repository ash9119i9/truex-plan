import { createHash } from "node:crypto";
import { canonical } from "../canonical";
import type { AdapterConfig } from "../config";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ChatRef,
  SteerRequest,
  StartRunRequest,
} from "../contract";
import { AdapterError } from "../errors";
import { ChatRuntime, type HistoryTurn, type SteerResult } from "./chat";
import { isFinished, Run } from "./run";

// Admission and bookkeeping for every chat this adapter serves: one active
// run per chat, idempotent run IDs, a bounded number of Codex processes, idle
// shutdown and drain on exit.

export type Logger = (event: string, fields: Record<string, unknown>) => void;

const SWEEP_MS = 30_000;

export class RuntimeManager {
  private readonly chats = new Map<string, ChatRuntime>();
  private readonly runs = new Map<string, Run>();
  private readonly executions = new Set<Promise<void>>();
  private slots = 0;
  private draining = false;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly config: Pick<
      AdapterConfig,
      "stateDir" | "codexBinary" | "maxProcesses" | "idleMs" | "limits"
    >,
    private readonly log: Logger = () => undefined,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  get stats() {
    let activeRuns = 0;
    for (const chat of this.chats.values()) if (chat.activeRun) activeRuns++;
    return { activeRuns, processes: this.slots, draining: this.draining };
  }

  // Admission is synchronous, so two requests for one chat can't both pass
  // the busy check. Execution continues in the background; the caller streams
  // the run's events.
  startRun(request: StartRunRequest): Run {
    const hash = requestHash(request);
    const existing = this.runs.get(request.runId);
    if (existing) {
      if (
        existing.requestHash !== hash ||
        existing.tenantId !== request.tenantId ||
        existing.chatId !== request.chatId
      )
        throw new AdapterError("RUN_CONFLICT");
      return existing;
    }
    if (this.draining) throw new AdapterError("DRAINING");
    const chat = this.chat(request);
    if (chat.activeRun) throw new AdapterError("CHAT_BUSY");
    this.reserveSlot(chat);
    const run = new Run(
      request.runId,
      request.tenantId,
      request.chatId,
      hash,
      this.config.limits.bufferEvents,
      request.input.clientMessageId,
    );
    this.runs.set(run.runId, run);
    const execution = chat.execute(run, request);
    this.executions.add(execution);
    void execution.finally(() => this.executions.delete(execution));
    return run;
  }

  getRun(runId: string, ref: ChatRef): Run {
    const run = this.runs.get(runId);
    // Another chat's run looks exactly like an unknown one.
    if (!run || run.tenantId !== ref.tenantId || run.chatId !== ref.chatId)
      throw new AdapterError("RUN_NOT_FOUND");
    return run;
  }

  stopRun(runId: string, ref: ChatRef): Run {
    const run = this.getRun(runId, ref);
    if (!isFinished(run.status)) this.chats.get(key(ref))?.interrupt("stopped");
    return run;
  }

  // Sends a message into a run's running turn. The run must exist and belong
  // to this chat (else RUN_NOT_FOUND); a finished run, or one with no active
  // turn, is RUN_ENDED. Validation, idempotency and serialization live in the
  // chat.
  // Answers a tool approval the run is waiting on. First answer wins: a
  // repeat is APPROVAL_RESOLVED; an approval this run never asked, or one
  // whose run has ended, is APPROVAL_NOT_FOUND.
  answerApproval(
    runId: string,
    approvalId: string,
    request: ApprovalRequest,
  ): ApprovalAnswer {
    const run = this.getRun(runId, request);
    const chat = this.chats.get(key(request));
    if (!chat || chat.activeRun !== run)
      throw new AdapterError("APPROVAL_NOT_FOUND");
    return chat.answerApproval(approvalId, request.decision);
  }

  steerRun(runId: string, input: SteerRequest): Promise<SteerResult> {
    const run = this.getRun(runId, input);
    const chat = this.chats.get(key(input));
    if (!chat || chat.activeRun !== run) throw new AdapterError("RUN_ENDED");
    return chat.steer(input.input);
  }

  async history(ref: ChatRef): Promise<HistoryTurn[]> {
    if (this.draining) throw new AdapterError("DRAINING");
    const chat = this.chat(ref);
    this.reserveSlot(chat);
    return chat.history();
  }

  // Stops admitting runs, lets active ones finish for up to `drainMs`, then
  // stops the rest and every Codex process.
  async drain(drainMs: number): Promise<void> {
    this.draining = true;
    clearInterval(this.sweeper);
    const waitAll = () => Promise.allSettled([...this.executions]);
    await Promise.race([waitAll(), sleep(drainMs)]);
    if (this.executions.size) {
      for (const chat of this.chats.values())
        chat.interrupt("RUNTIME_SHUTDOWN");
      await Promise.race([waitAll(), sleep(this.config.limits.stopMs + 1000)]);
    }
    await Promise.allSettled(
      [...this.chats.values()].map((chat) => chat.close()),
    );
  }

  // Forgets finished runs after their reconnect window and stops processes
  // idle longer than `idleMs`. Files stay on disk for the next resume.
  async sweep(now = Date.now()): Promise<void> {
    for (const [runId, run] of this.runs)
      if (
        run.finishedAt !== undefined &&
        now - run.finishedAt > this.config.limits.finishedRunTtlMs
      )
        this.runs.delete(runId);
    const idle: Promise<void>[] = [];
    for (const [chatKey, chat] of this.chats) {
      if (chat.activeRun) continue;
      if (now - chat.lastUsedAt < this.config.idleMs) continue;
      if (chat.hasProcess) idle.push(chat.close());
      else if (!chat.hasSlot) this.chats.delete(chatKey);
    }
    await Promise.allSettled(idle);
  }

  private chat(ref: ChatRef): ChatRuntime {
    const chatKey = key(ref);
    let chat = this.chats.get(chatKey);
    if (!chat) {
      chat = new ChatRuntime(ref.tenantId, ref.chatId, this.config.stateDir, {
        binary: this.config.codexBinary,
        limits: this.config.limits,
        releaseSlot: (c) => this.releaseSlot(c),
        log: this.log,
      });
      this.chats.set(chatKey, chat);
    }
    return chat;
  }

  // A chat holds a slot from admission until its process exits. At capacity
  // the least recently used idle process is stopped to make room.
  private reserveSlot(chat: ChatRuntime): void {
    if (chat.hasSlot) return;
    if (this.slots >= this.config.maxProcesses) {
      let victim: ChatRuntime | undefined;
      for (const other of this.chats.values())
        if (other.hasSlot && !other.activeRun && other.hasProcess)
          if (!victim || other.lastUsedAt < victim.lastUsedAt) victim = other;
      if (!victim) throw new AdapterError("RUNTIME_BUSY");
      this.releaseSlot(victim);
      void victim.close();
    }
    chat.hasSlot = true;
    this.slots++;
  }

  private releaseSlot(chat: ChatRuntime): void {
    if (!chat.hasSlot) return;
    chat.hasSlot = false;
    this.slots--;
  }
}

function key(ref: ChatRef): string {
  return `${ref.tenantId}/${ref.chatId}`;
}

// Same turn → same hash. Object keys are sorted so field order doesn't
// matter. The gateway token is a credential, not part of the turn, so a retry
// carrying a refreshed token still attaches. MCP header VALUES are treated the
// same way: a connector's rotated token is a credential, not part of the turn,
// and must never reach the hash surface — only the connector names, URLs,
// header NAMES, enabled tools and timeouts shape the hash. `approvedTools` is
// left out too: it grows while a run waits (the member picks "Allow for this
// chat"), so a recovery that resends the run with the longer list must still
// match.
function requestHash(request: StartRunRequest): string {
  const { gatewayToken: _token, ...model } = request.model;
  const mcp = request.mcp?.map(({ approvedTools: _approved, ...server }) => ({
    ...server,
    headers: Object.keys(server.headers).sort(),
  }));
  return createHash("sha256")
    .update(canonical({ ...request, model, ...(mcp ? { mcp } : {}) }))
    .digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
