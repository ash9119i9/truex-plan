import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLimits } from "../config";
import type { StartRunRequest } from "../contract";
import { threadResumeParams, threadStartParams } from "../codex/config";
import {
  CodexProcess,
  ProcessExited,
  RpcError,
  RpcTimeout,
  type Notification,
} from "../codex/rpc";
import {
  AdapterError,
  fromCodexErrorInfo,
  runError,
  type RunError,
  type RunErrorCode,
} from "../errors";
import { isFinished, type Run } from "./run";

// One chat's Codex home, process and active run. A chat has exactly one
// thread, recorded in `chat.json` the moment Codex creates it, so a retried
// first message reuses that thread instead of creating a second one.

export interface ChatHost {
  readonly binary: string;
  readonly limits: RuntimeLimits;
  // Called when the chat's process slot is free again.
  releaseSlot(chat: ChatRuntime): void;
  log(event: string, fields: Record<string, unknown>): void;
}

export interface HistoryTurn {
  readonly turnId: string;
  readonly status: string;
  readonly clientMessageId: string | null;
  readonly text: string;
}

const HISTORY_TURNS = 20;
// JSON-RPC invalid request / method not found / invalid params.
const REJECTED = new Set([-32600, -32601, -32602]);
// Events that arrive before turn/start answers; normally a handful.
const EARLY_LIMIT = 1000;

type Usage = Record<string, unknown>;

interface Active {
  readonly run: Run;
  // The process this run's turn lives in; only its exit fails the run.
  codex: CodexProcess | undefined;
  readonly limits: StartRunRequest["limits"];
  failReason: RunErrorCode | undefined;
  interrupting: boolean;
  sawModelOutput: boolean;
  usage: Usage | null;
  watchdog: NodeJS.Timeout | undefined;
  stopTimer: NodeJS.Timeout | undefined;
  early: Notification[];
  settle: () => void;
}

export class ChatRuntime {
  // True while this chat holds one of the manager's process slots.
  hasSlot = false;
  lastUsedAt = Date.now();
  private process: CodexProcess | undefined;
  private starting: Promise<CodexProcess> | undefined;
  private closing: Promise<void> | undefined;
  private loadedThreadId: string | null = null;
  private active: Active | undefined;
  private readonly home: string;
  private readonly workspace: string;
  private readonly recordPath: string;

  constructor(
    readonly tenantId: string,
    readonly chatId: string,
    stateDir: string,
    private readonly host: ChatHost,
  ) {
    const root = join(stateDir, "t", tenantId, "c", chatId);
    this.home = join(root, "home");
    this.workspace = join(root, "workspace");
    this.recordPath = join(root, "chat.json");
  }

  get activeRun(): Run | undefined {
    return this.active?.run;
  }

  get hasProcess(): boolean {
    return (
      this.process?.isAlive === true ||
      this.starting !== undefined ||
      this.closing !== undefined
    );
  }

  // Runs one turn to its outcome. Never throws: every failure finishes the
  // run with a typed error and the delivery state known at that point.
  async execute(run: Run, request: StartRunRequest): Promise<void> {
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const active: Active = {
      run,
      codex: undefined,
      limits: request.limits,
      failReason: undefined,
      interrupting: false,
      sawModelOutput: false,
      usage: null,
      watchdog: undefined,
      stopTimer: undefined,
      early: [],
      settle: settled,
    };
    this.active = active;
    try {
      const codex = await this.prepareThread(run, request);
      active.codex = codex;
      if (run.stopRequested) return this.settleStopped(active);
      codex.setListener((n) => this.onNotification(active, n));
      run.timings.dispatchedAt = Date.now();
      run.delivery = "unknown";
      this.armWatchdog(active, request.limits.firstResponseMs);
      let turnId: string;
      try {
        const accepted = await codex.request<{ turn: { id: string } }>(
          "turn/start",
          {
            threadId: run.threadId,
            clientUserMessageId: request.input.clientMessageId,
            input: [
              { type: "text", text: request.input.text, text_elements: [] },
            ],
          },
        );
        turnId = accepted.turn.id;
      } catch (error) {
        // Codex rejects an invalid turn/start (unknown thread, bad params)
        // before running anything; any other failure leaves it unknown.
        if (error instanceof RpcError && REJECTED.has(error.code))
          run.delivery = "none";
        if (error instanceof RpcTimeout) codex.kill();
        throw error;
      }
      if (isFinished(run.status)) return;
      run.delivery = "accepted";
      run.turnId = turnId;
      run.status = active.interrupting ? "stopping" : "running";
      run.emit("run.accepted", {
        threadId: run.threadId,
        turnId,
        resumed: run.resumed,
      });
      for (const n of active.early.splice(0)) this.onNotification(active, n);
      if (active.interrupting) this.sendInterrupt(active);
      await done;
    } catch (error) {
      this.finish(active, "failed", this.toRunError(error, active));
    } finally {
      this.clearTimers(active);
      if (this.active === active) this.active = undefined;
      this.lastUsedAt = Date.now();
      if (!this.hasProcess) this.host.releaseSlot(this);
    }
  }

  // Stops the active run once. A repeated stop, or one for a finished run, is
  // a no-op: Codex never answers a second interrupt sent while one is pending.
  interrupt(reason: "stopped" | RunErrorCode): void {
    const active = this.active;
    if (!active || isFinished(active.run.status) || active.interrupting) return;
    active.interrupting = true;
    if (reason !== "stopped") active.failReason = reason;
    const run = active.run;
    run.stopRequested = true;
    if (run.status === "starting") return; // handled once the turn is accepted
    run.status = "stopping";
    this.sendInterrupt(active);
  }

  async history(): Promise<HistoryTurn[]> {
    try {
      return await this.readHistory();
    } finally {
      if (!this.hasProcess) this.host.releaseSlot(this);
    }
  }

  private async readHistory(): Promise<HistoryTurn[]> {
    const threadId = await this.readRecord();
    if (!threadId) throw new AdapterError("THREAD_LOST");
    const codex = await this.ensureProcess();
    let page: { data: Array<Record<string, unknown>> };
    try {
      page = await codex.request("thread/turns/list", {
        threadId,
        limit: HISTORY_TURNS,
        itemsView: "full",
      });
    } catch (error) {
      if (error instanceof RpcError && isMissingThread(error))
        throw new AdapterError("THREAD_LOST");
      throw new AdapterError("RUNTIME_UNAVAILABLE");
    } finally {
      this.lastUsedAt = Date.now();
    }
    return page.data.map(toHistoryTurn);
  }

  // Stops the process. The chat's files stay on disk for the next resume.
  // A new process waits for the old one to exit, so two never share a home.
  close(): Promise<void> {
    this.closing ??= (async () => {
      const codex =
        this.process ?? (await this.starting?.catch(() => undefined));
      this.process = undefined;
      this.loadedThreadId = null;
      await codex?.stop();
    })().finally(() => {
      this.closing = undefined;
      if (!this.hasProcess) this.host.releaseSlot(this);
    });
    return this.closing;
  }

  private async prepareThread(run: Run, request: StartRunRequest) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    const recorded = await this.readRecord();
    if (request.threadId && !recorded) throw new ThreadFailure("THREAD_LOST");
    if (request.threadId && recorded !== request.threadId)
      throw new ThreadFailure("THREAD_MISMATCH");
    const codex = await this.ensureProcess();
    if (!recorded) {
      const started = await codex.request<{ thread: { id: string } }>(
        "thread/start",
        threadStartParams(request.model, request.agentPrompt, this.workspace),
      );
      await this.writeRecord(started.thread.id);
      run.threadId = started.thread.id;
      this.loadedThreadId = started.thread.id;
      return codex;
    }
    run.threadId = recorded;
    if (this.loadedThreadId !== recorded) {
      try {
        await codex.request(
          "thread/resume",
          threadResumeParams(recorded, request.model, this.workspace),
        );
      } catch (error) {
        if (error instanceof RpcError && isMissingThread(error))
          throw new ThreadFailure("THREAD_LOST");
        throw error;
      }
      this.loadedThreadId = recorded;
      run.resumed = true;
    }
    return codex;
  }

  private ensureProcess(): Promise<CodexProcess> {
    if (this.process?.isAlive && !this.closing)
      return Promise.resolve(this.process);
    this.starting ??= (async () => {
      await this.closing;
      const codex = new CodexProcess({
        binary: this.host.binary,
        home: this.home,
        workspace: this.workspace,
        rpcMs: this.host.limits.rpcMs,
      });
      codex.onExit = () => this.onProcessExit(codex);
      try {
        await codex.initialize();
      } catch (error) {
        codex.kill();
        throw error;
      }
      this.process = codex;
      return codex;
    })().finally(() => {
      this.starting = undefined;
      if (!this.process?.isAlive) this.host.releaseSlot(this);
    });
    return this.starting;
  }

  private onProcessExit(codex: CodexProcess): void {
    if (this.process === codex) {
      this.process = undefined;
      this.loadedThreadId = null;
    }
    const active = this.active;
    if (active?.codex === codex && !isFinished(active.run.status)) {
      this.host.log("codex_exit_mid_run", {
        runId: active.run.runId,
        // Codex's stderr is untrusted and may echo provider text, so only
        // its size is logged.
        stderrLines: codex.diagnostics.length,
      });
      if (active.interrupting) this.settleStopped(active);
      else this.finish(active, "failed", runError("RUNTIME_ERROR"));
    }
    if (!this.hasProcess) this.host.releaseSlot(this);
  }

  private onNotification(active: Active, n: Notification): void {
    const run = active.run;
    if (isFinished(run.status)) return;
    const turnId =
      typeof n.params.turnId === "string" ? n.params.turnId : undefined;
    const turn = n.params.turn as { id?: string } | undefined;
    const eventTurn = turnId ?? turn?.id;
    if (!run.turnId) {
      // Only deltas are dropped past the cap; lifecycle events always stay.
      if (
        eventTurn &&
        (active.early.length < EARLY_LIMIT || !n.method.endsWith("/delta"))
      )
        active.early.push(n);
      return;
    }
    if (eventTurn && eventTurn !== run.turnId) return;

    switch (n.method) {
      case "item/agentMessage/delta":
        this.activity(active);
        run.appendText(String(n.params.itemId), String(n.params.delta ?? ""));
        return;
      case "item/started":
      case "item/completed": {
        const item = n.params.item as Record<string, unknown> | undefined;
        if (!item || item.type === "userMessage") return;
        this.activity(active);
        if (n.method === "item/completed" && item.type === "agentMessage")
          run.completeItem(String(item.id), String(item.text ?? ""));
        if (n.method === "item/completed" && item.type === "contextCompaction")
          run.emit("compaction", { itemId: String(item.id) });
        return;
      }
      case "error":
        if (n.params.willRetry === true) {
          this.activity(active);
          const error = n.params.error as
            { codexErrorInfo?: unknown } | undefined;
          run.emit("retrying", {
            code: fromCodexErrorInfo(error?.codexErrorInfo).code,
          });
        }
        return;
      case "thread/tokenUsage/updated": {
        const usage = n.params.tokenUsage as
          Record<string, unknown> | undefined;
        if (!usage) return;
        active.usage = {
          last: usage.last,
          total: usage.total,
          contextWindow: usage.modelContextWindow ?? null,
        };
        run.emit("usage", active.usage);
        return;
      }
      case "turn/completed":
        this.onTurnCompleted(active, n.params.turn as Record<string, unknown>);
        return;
      default:
        if (n.method.startsWith("item/reasoning/")) this.activity(active);
    }
  }

  private onTurnCompleted(active: Active, turn: Record<string, unknown>): void {
    const status = turn.status;
    if (status === "completed") return this.finish(active, "completed", null);
    if (status === "interrupted") return this.settleStopped(active);
    const error = turn.error as { codexErrorInfo?: unknown } | null;
    this.finish(active, "failed", fromCodexErrorInfo(error?.codexErrorInfo));
  }

  private sendInterrupt(active: Active): void {
    const run = active.run;
    const codex = this.process;
    if (!codex || !run.turnId) return;
    this.clearWatchdog(active);
    // Before any model output Codex is usually still waiting for the
    // provider's response headers, and it does not act on an interrupt until
    // they arrive (the gateway sends them only with its first output). Nothing
    // has been shown yet, so settle now and restart the process; Codex records
    // the turn as interrupted and the next message resumes cleanly.
    if (!active.sawModelOutput) {
      this.settleStopped(active);
      void this.close();
      return;
    }
    // Codex answers "no active turn" if the turn just finished; its
    // turn/completed settles the run either way.
    void codex
      .request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId })
      .catch(() => undefined);
    active.stopTimer = setTimeout(() => {
      // No confirmation in time: settle here and restart the process so the
      // next turn starts clean.
      if (isFinished(run.status)) return;
      this.host.log("interrupt_timeout", { runId: run.runId });
      this.settleStopped(active);
      void this.close();
    }, this.host.limits.stopMs);
  }

  // A stop settles as "stopped"; a watchdog or shutdown stop as its failure.
  private settleStopped(active: Active): void {
    if (active.failReason)
      this.finish(active, "failed", runError(active.failReason));
    else this.finish(active, "stopped", null);
  }

  private activity(active: Active): void {
    active.sawModelOutput = true;
    if (!active.interrupting) this.armWatchdog(active, active.limits.silenceMs);
  }

  private armWatchdog(active: Active, ms: number): void {
    this.clearWatchdog(active);
    active.watchdog = setTimeout(() => {
      this.host.log("model_timeout", {
        runId: active.run.runId,
        sawModelOutput: active.sawModelOutput,
      });
      this.interrupt("MODEL_TIMEOUT");
      // A timeout before turn/start answered has no turn to interrupt yet.
      if (active.run.status === "starting") {
        this.finish(active, "failed", runError("MODEL_TIMEOUT"));
        void this.close();
      }
    }, ms);
  }

  private clearWatchdog(active: Active): void {
    if (active.watchdog) clearTimeout(active.watchdog);
    active.watchdog = undefined;
  }

  private clearTimers(active: Active): void {
    this.clearWatchdog(active);
    if (active.stopTimer) clearTimeout(active.stopTimer);
    active.stopTimer = undefined;
  }

  private finish(
    active: Active,
    status: "completed" | "stopped" | "failed",
    error: RunError | null,
  ): void {
    if (isFinished(active.run.status)) return;
    this.clearTimers(active);
    active.run.finish(status, error, active.usage);
    this.host.log("run_finished", {
      runId: active.run.runId,
      status,
      code: error?.code ?? null,
      delivery: active.run.delivery,
      ms: Date.now() - active.run.timings.receivedAt,
    });
    active.settle();
  }

  private toRunError(error: unknown, active: Active): RunError {
    if (error instanceof ThreadFailure) return runError(error.code);
    if (active.failReason) return runError(active.failReason);
    if (!(
      error instanceof RpcError ||
      error instanceof RpcTimeout ||
      error instanceof ProcessExited
    ))
      this.host.log("run_error", {
        runId: active.run.runId,
        error: error instanceof Error ? error.name : typeof error,
      });
    return runError("RUNTIME_ERROR");
  }

  private async readRecord(): Promise<string | null> {
    try {
      const record = JSON.parse(await readFile(this.recordPath, "utf8")) as {
        threadId?: unknown;
      };
      return typeof record.threadId === "string" ? record.threadId : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // Write-then-rename so a crash never leaves a half-written record.
  private async writeRecord(threadId: string): Promise<void> {
    const temp = `${this.recordPath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({ threadId, createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    await rename(temp, this.recordPath);
  }
}

class ThreadFailure extends Error {
  constructor(readonly code: "THREAD_LOST" | "THREAD_MISMATCH") {
    super(code);
  }
}

// Codex reports a thread with no saved history as "no rollout found" and an
// unknown one as "thread not found"; both are -32600.
function isMissingThread(error: RpcError): boolean {
  return /no rollout found|thread not found/i.test(error.message);
}

function toHistoryTurn(turn: Record<string, unknown>): HistoryTurn {
  const items = (turn.items ?? []) as Array<Record<string, unknown>>;
  const user = items.find((item) => item.type === "userMessage");
  const text = items
    .filter((item) => item.type === "agentMessage")
    .map((item) => String(item.text ?? ""))
    .join("\n\n");
  return {
    turnId: String(turn.id),
    status: String(turn.status),
    clientMessageId: typeof user?.clientId === "string" ? user.clientId : null,
    text,
  };
}
