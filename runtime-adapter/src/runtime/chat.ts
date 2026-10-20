import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLimits } from "../config";
import { canonical } from "../canonical";
import type {
  ApprovalAnswer,
  McpServerSpec,
  StartRunRequest,
} from "../contract";
import { threadResumeParams, threadStartParams } from "../codex/config";
import {
  CodexProcess,
  ProcessExited,
  RpcError,
  RpcTimeout,
  type Notification,
  type ServerRequest,
} from "../codex/rpc";
import {
  AdapterError,
  fromCodexErrorInfo,
  runError,
  type RunError,
  type RunErrorCode,
} from "../errors";
import {
  isFinished,
  type ApprovalDecision,
  type ApprovalParam,
  type PendingApproval,
  type Run,
  type ToolErrorCode,
} from "./run";

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
  // Codex's items in order: each userMessage (including the turn's first
  // input) and each agentMessage reply. Lets the platform recover a steered
  // turn's shape, not just its joined text.
  readonly items: ReadonlyArray<HistoryItem>;
}

export type HistoryItem =
  | { readonly type: "input"; readonly clientMessageId: string | null }
  | { readonly type: "reply"; readonly text: string };

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
  // Resolves once the turn is accepted (turnId known) or the run finishes, so
  // a steer that arrives while the run is `starting` can wait for acceptance.
  readonly accepted: Promise<void>;
  wake: () => void;
  // Per-run steer state: in-flight/settled outcomes keyed by clientMessageId
  // (idempotency), a chain that sends them one at a time in arrival order, and
  // the count enforcing the safety cap.
  readonly steers: Map<string, { text: string; promise: Promise<SteerResult> }>;
  steerChain: Promise<void>;
  steerCount: number;
  // MCP servers keyed by connector name, so the watchdog can find a connector's
  // `toolTimeoutSec` while its call is in flight. Empty for a text-only run.
  readonly mcpByName: Map<string, McpServerSpec>;
  // Connector tool calls in progress, with their arguments' canonical JSON,
  // so an approval request can be matched to its call. The arguments stay in
  // memory for the call's life and are never emitted or logged.
  readonly calls: Map<string, ToolCall>;
  // Approvals waiting for the member, by approvalId.
  readonly approvals: Map<string, ApprovalWait>;
  // Answered approvals, so a repeat answer is told apart from an unknown id.
  readonly answered: Map<string, ApprovalDecision>;
  // Tool calls whose approval did not allow them.
  readonly denied: Set<string>;
  // Tools the member allowed for this chat, per connector; grows when they
  // pick "Allow for this chat" during the run.
  readonly allowed: Map<string, Set<string>>;
  // Approval requests that arrived before turn/start answered.
  readonly earlyRequests: Array<{
    codex: CodexProcess;
    request: ServerRequest;
  }>;
}

interface ToolCall {
  readonly connector: string;
  readonly tool: string;
  readonly args: string;
  asked: boolean;
}

interface ApprovalWait {
  readonly approval: PendingApproval;
  readonly rpcId: string | number;
  readonly codex: CodexProcess;
  readonly timer: NodeJS.Timeout;
}

// Answers to Codex's tool approval (`mcpServer/elicitation/request`). "Allow
// for this chat" is held here, not by Codex: its session memory is lost on
// every process restart and would let later calls run unaudited, so Codex
// is never sent `persist`.
const APPROVAL_ACCEPT = { action: "accept", content: {}, _meta: null };
const APPROVAL_DECLINE = { action: "decline", content: null, _meta: null };
const APPROVAL_CANCEL = { action: "cancel", content: null, _meta: null };
const ELICITATION = "mcpServer/elicitation/request";
// Bounds on what the approval card shows of a call's arguments.
const MAX_APPROVAL_PARAMS = 12;
const MAX_APPROVAL_NAME = 64;
const MAX_APPROVAL_VALUE = 500;

export interface SteerResult {
  readonly status: "queued";
}

// More than this many steers on one run is refused; the platform caps far
// lower (5). A safety net against a runaway caller.
const STEER_LIMIT = 20;

// Extra time a tool call is allowed over its server's `toolTimeoutSec` before
// the watchdog fails the run. Codex itself times the call out at
// `toolTimeoutSec` and then reports it, so the grace only covers the round
// trip of that report reaching the adapter.
const TOOL_WATCHDOG_GRACE_MS = 15_000;

export class ChatRuntime {
  // True while this chat holds one of the manager's process slots.
  hasSlot = false;
  lastUsedAt = Date.now();
  private process: CodexProcess | undefined;
  private starting: Promise<CodexProcess> | undefined;
  private closing: Promise<void> | undefined;
  private loadedThreadId: string | null = null;
  // sha256 of the MCP spec list (including header values) last applied to the
  // loaded thread. Only the hash is kept in memory, never the headers. A new
  // run whose fingerprint differs forces a fresh resume so the new spec (e.g. a
  // rotated token) takes effect — see `prepareThread`.
  private loadedMcpFingerprint = "";
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
    let wake!: () => void;
    const accepted = new Promise<void>((resolve) => (wake = resolve));
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
      accepted,
      wake,
      steers: new Map(),
      steerChain: Promise.resolve(),
      steerCount: 0,
      mcpByName: new Map((request.mcp ?? []).map((s) => [s.name, s])),
      calls: new Map(),
      approvals: new Map(),
      answered: new Map(),
      denied: new Set(),
      allowed: new Map(
        (request.mcp ?? []).map((s) => [s.name, new Set(s.approvedTools)]),
      ),
      earlyRequests: [],
    };
    this.active = active;
    try {
      const codex = await this.prepareThread(run, request, active);
      active.codex = codex;
      if (run.stopRequested) return this.settleStopped(active);
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
      active.wake(); // release steers waiting for acceptance
      for (const n of active.early.splice(0)) this.onNotification(active, n);
      for (const { codex: from, request } of active.earlyRequests.splice(0))
        this.onApprovalRequest(active, from, request);
      if (active.interrupting) this.sendInterrupt(active);
      await done;
    } catch (error) {
      this.finish(active, "failed", this.toRunError(error, active));
    } finally {
      this.clearTimers(active);
      active.wake(); // a steer may still be waiting if the run never accepted
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
    // After the interrupt, so the model cannot act on the refusal first.
    this.endApprovals(active, "cancelled");
  }

  // The member's answer to a pending approval. First answer wins.
  answerApproval(approvalId: string, answer: ApprovalAnswer): ApprovalAnswer {
    const active = this.active;
    if (active?.approvals.has(approvalId)) {
      this.settleApproval(active, approvalId, answer, true);
      return answer;
    }
    if (active?.answered.has(approvalId))
      throw new AdapterError("APPROVAL_RESOLVED");
    throw new AdapterError("APPROVAL_NOT_FOUND");
  }

  // Sends a message into the running turn. Idempotent per run on
  // `clientMessageId`: a repeat with the same text waits on and returns the
  // first attempt's answer; a different text, or the run's own input id, is
  // RUN_CONFLICT. Steers are serialized in arrival order, and one that arrives
  // while the run is still `starting` waits for acceptance. Never resolves
  // until Codex has answered `turn/steer` (or its answer was lost).
  steer(input: {
    readonly text: string;
    readonly clientMessageId: string;
  }): Promise<SteerResult> {
    const active = this.active;
    if (!active || isFinished(active.run.status))
      throw new AdapterError("RUN_ENDED");
    const { clientMessageId: cid, text } = input;
    const existing = active.steers.get(cid);
    if (existing) {
      if (existing.text !== text) throw new AdapterError("RUN_CONFLICT");
      return existing.promise;
    }
    if (cid === active.run.inputClientMessageId)
      throw new AdapterError("RUN_CONFLICT");
    if (active.steerCount >= STEER_LIMIT) throw new AdapterError("STEER_LIMIT");
    active.steerCount++;
    const promise = (async () => {
      // Wait our turn, then for acceptance, then send. Each step re-checks the
      // run is still live so a stop or completion in between yields RUN_ENDED.
      const prior = active.steerChain;
      let release!: () => void;
      active.steerChain = new Promise<void>((resolve) => (release = resolve));
      try {
        await prior;
        await active.accepted;
        return await this.sendSteer(active, cid, text);
      } finally {
        release();
      }
    })();
    active.steers.set(cid, { text, promise });
    return promise;
  }

  private async sendSteer(
    active: Active,
    clientMessageId: string,
    text: string,
  ): Promise<SteerResult> {
    const run = active.run;
    const codex = active.codex ?? this.process;
    if (!codex || !run.turnId || isFinished(run.status) || run.stopRequested)
      throw new AdapterError("RUN_ENDED");
    // The member wrote instead of answering: a waiting tool call is denied,
    // so the steer is not stuck behind it and nothing runs unapproved.
    this.endApprovals(active, "deny");
    try {
      await codex.request("turn/steer", {
        threadId: run.threadId,
        expectedTurnId: run.turnId,
        clientUserMessageId: clientMessageId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      return { status: "queued" };
    } catch (error) {
      // Codex answers -32600 when the turn just ended or a newer turn is
      // active ("no active turn" / "expected active turn id …"): nothing was
      // delivered, so the platform sends it as a fresh run instead.
      if (error instanceof RpcError && error.code === -32600)
        throw new AdapterError("RUN_ENDED");
      // The request went out but its answer was lost (RPC timeout, process
      // exit) — or any other RPC failure: never resend, the saved items show
      // whether it was used.
      throw new AdapterError("STEER_UNKNOWN");
    }
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
      this.loadedMcpFingerprint = "";
      await codex?.stop();
    })().finally(() => {
      this.closing = undefined;
      if (!this.hasProcess) this.host.releaseSlot(this);
    });
    return this.closing;
  }

  private async prepareThread(
    run: Run,
    request: StartRunRequest,
    active: Active,
  ) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    const recorded = await this.readRecord();
    if (request.threadId && !recorded) throw new ThreadFailure("THREAD_LOST");
    if (request.threadId && recorded !== request.threadId)
      throw new ThreadFailure("THREAD_MISMATCH");
    const mcp = request.mcp ?? [];
    const fingerprint = mcpFingerprint(mcp);
    if (
      recorded &&
      this.loadedThreadId === recorded &&
      this.loadedMcpFingerprint !== fingerprint
    )
      await this.restartForMcpChange();
    const codex = await this.ensureProcess();
    // Attach the listener before thread/start or thread/resume so a connector's
    // `mcpServer/startupStatus/updated` (which the pin emits during those calls,
    // before any turn exists) reaches the run and surfaces as `connector.status`.
    codex.setListener((n) => this.onNotification(active, n));
    codex.setRequestHandler((r) => this.onServerRequest(active, codex, r));
    if (!recorded) {
      const started = await codex.request<{ thread: { id: string } }>(
        "thread/start",
        threadStartParams(
          request.model,
          request.agentPrompt,
          this.workspace,
          mcp,
        ),
      );
      await this.writeRecord(started.thread.id);
      run.threadId = started.thread.id;
      this.loadedThreadId = started.thread.id;
      this.loadedMcpFingerprint = fingerprint;
      return codex;
    }
    run.threadId = recorded;
    // Resume when the thread is not the one loaded in this process. A changed
    // MCP spec has already restarted the process above, so it lands here too.
    if (this.loadedThreadId !== recorded) {
      try {
        await codex.request(
          "thread/resume",
          threadResumeParams(recorded, request.model, this.workspace, mcp),
        );
      } catch (error) {
        if (error instanceof RpcError && isMissingThread(error))
          throw new ThreadFailure("THREAD_LOST");
        throw error;
      }
      if (this.loadedThreadId !== recorded) run.resumed = true;
      this.loadedThreadId = recorded;
      this.loadedMcpFingerprint = fingerprint;
    }
    return codex;
  }

  // The pin applies a thread's MCP config only when it loads the thread:
  // thread/resume on a thread that is already loaded keeps the old headers
  // (verified on the pin, mcp.test.ts "rotated while the thread stays
  // loaded"). A changed spec (a refreshed token, another connector set)
  // therefore stops this chat's process so the thread is loaded afresh. The
  // slot stays held: `closing` keeps `hasProcess` true through the exit, and
  // the run starts the next process right after.
  private async restartForMcpChange(): Promise<void> {
    const codex = this.process;
    this.process = undefined;
    this.loadedThreadId = null;
    this.loadedMcpFingerprint = "";
    if (!codex) return;
    this.host.log("mcp_reload", {
      tenantId: this.tenantId,
      chatId: this.chatId,
    });
    this.closing = codex.stop().finally(() => {
      this.closing = undefined;
    });
    await this.closing;
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
      this.loadedMcpFingerprint = "";
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
    // A connector's startup status carries no turn id and can arrive during
    // thread/start or thread/resume (before any turn). Surface it immediately;
    // it is not tied to a turn.
    if (n.method === "mcpServer/startupStatus/updated")
      return this.onConnectorStatus(active, n);
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
        if (!item) return;
        if (item.type === "userMessage") {
          // A userMessage that completes with a clientId is a steer entering
          // the turn (the run's own input is filtered by the Run). It marks
          // where the steer landed; the reply it cut off never completes.
          if (
            n.method === "item/completed" &&
            typeof item.clientId === "string"
          )
            run.recordInput(item.clientId);
          return;
        }
        if (item.type === "mcpToolCall") {
          this.onToolItem(active, n.method, item);
          return;
        }
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
      case "serverRequest/resolved":
        // Codex withdrew a request (its turn ended or was interrupted). Our
        // own answers are followed by this too; by then the wait is gone.
        for (const [approvalId, wait] of active.approvals)
          if (wait.rpcId === n.params.requestId)
            this.settleApproval(active, approvalId, "cancelled", false);
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

  // Maps an mcpToolCall item to tool events. `item/started` opens the call;
  // `item/completed` closes it. Arguments and the result are never read: only
  // the id, connector, tool, status, duration and a coarse error code leave
  // the adapter. The call counts as model activity for the watchdog.
  private onToolItem(
    active: Active,
    method: string,
    item: Record<string, unknown>,
  ): void {
    const run = active.run;
    const itemId = String(item.id ?? "");
    const connector = String(item.server ?? "");
    const tool = String(item.tool ?? "");
    if (!itemId) return;
    // Codex's own MCP resource helpers arrive as mcpToolCall items too (with
    // server "codex", or the connector named in the call). They are not
    // connector tools, so they count as activity but never become tool rows.
    if (CODEX_RESOURCE_TOOLS.has(tool)) return this.activity(active);
    if (method === "item/started") {
      active.calls.set(itemId, {
        connector,
        tool,
        args: canonical(item.arguments ?? null),
        asked: false,
      });
      run.startTool(itemId, connector, tool);
      // A tool call in flight needs the longer, tool-specific watchdog.
      this.activity(active);
      return;
    }
    // item/completed
    const rawStatus = item.status;
    const status: "completed" | "failed" =
      rawStatus === "completed" ? "completed" : "failed";
    active.calls.delete(itemId);
    const durationMs = this.toolDurationMs(item);
    const errorCode =
      status !== "failed"
        ? undefined
        : active.denied.has(itemId)
          ? "DENIED"
          : classifyToolError(item);
    run.completeTool(itemId, connector, tool, status, durationMs, errorCode);
    // Completing the (possibly last) call re-arms the ordinary silence timer.
    this.activity(active);
  }

  // Codex reports `durationMs` directly; fall back to 0 when it is absent
  // (older history) rather than inventing a value.
  private toolDurationMs(item: Record<string, unknown>): number {
    const value = item.durationMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : 0;
  }

  // A connector's startup status → a `connector.status` event. Only the state
  // and a coarse reason cross the boundary, never the raw error text.
  private onConnectorStatus(active: Active, n: Notification): void {
    const connector =
      typeof n.params.name === "string" ? n.params.name : undefined;
    if (!connector) return;
    const raw = n.params.status;
    const status =
      raw === "ready" ? "ready" : raw === "failed" ? "failed" : "starting";
    let reason: "auth" | "unreachable" | "unknown" | undefined;
    if (status === "failed")
      reason = classifyConnectorFailure(n.params.failureReason, n.params.error);
    active.run.connectorStatus(connector, status, reason);
  }

  // A tool call before any text still counts: it means the model produced
  // output and chose to call a tool.
  private activity(active: Active): void {
    active.sawModelOutput = true;
    if (!active.interrupting) this.rearmWatchdog(active);
  }

  // Picks the silence interval: while any MCP tool call is in flight the timer
  // is the slowest in-flight call's own limit (its server's `toolTimeoutSec`
  // plus a grace), because Codex sends no notification while a tool runs; once
  // the last call completes it falls back to the ordinary `silenceMs`.
  private rearmWatchdog(active: Active): void {
    if (active.interrupting) return;
    // The approval's own timer bounds a wait for the member.
    if (active.approvals.size > 0) return this.clearWatchdog(active);
    let ms = active.limits.silenceMs;
    if (active.run.inFlightToolCount > 0) {
      let toolMs = 0;
      for (const server of active.mcpByName.values()) {
        const limit = server.toolTimeoutSec * 1000 + TOOL_WATCHDOG_GRACE_MS;
        if (limit > toolMs) toolMs = limit;
      }
      // A connector may be unknown (defensive); keep at least the grace window.
      ms = Math.max(ms, toolMs || TOOL_WATCHDOG_GRACE_MS);
    }
    this.armWatchdog(active, ms);
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
    // Before the terminal event, so each approval's end is recorded.
    this.endApprovals(active, "cancelled");
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

  // Codex asks the client before a connector tool that is not marked
  // read-only. Anything else Codex asks is refused by the RPC layer.
  private onServerRequest(
    active: Active,
    codex: CodexProcess,
    request: ServerRequest,
  ): boolean {
    if (request.method !== ELICITATION) return false;
    const run = active.run;
    if (!run.turnId && !isFinished(run.status))
      active.earlyRequests.push({ codex, request });
    else this.onApprovalRequest(active, codex, request);
    return true;
  }

  // Matches the request to the tool call it is for, then answers it from a
  // standing allow for this chat or shows the member a card. A request that
  // is not a tool approval, belongs to another turn or matches no call is
  // declined: nothing runs without a known, approved call.
  private onApprovalRequest(
    active: Active,
    codex: CodexProcess,
    request: ServerRequest,
  ): void {
    const run = active.run;
    const { params } = request;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const connector =
      typeof params.serverName === "string" ? params.serverName : "";
    const decline = (reason: string) => {
      this.host.log("approval_declined", { runId: run.runId, reason });
      codex.respond(request.id, APPROVAL_DECLINE);
    };
    if (isFinished(run.status) || active.interrupting)
      return decline("run_ended");
    if (meta.codex_approval_kind !== "mcp_tool_call")
      return decline("not_tool_approval");
    if (params.threadId !== run.threadId || params.turnId !== run.turnId)
      return decline("other_turn");
    if (!active.mcpByName.has(connector)) return decline("unknown_connector");
    const match = matchCall(active.calls, connector, meta.tool_params);
    if (!match) return decline("unmatched");
    const [itemId, call] = match;
    call.asked = true;
    const approval = {
      approvalId: `ap_${randomUUID()}`,
      itemId,
      connector,
      tool: call.tool,
      params: approvalParams(meta),
    };
    if (active.allowed.get(connector)?.has(call.tool)) {
      codex.respond(request.id, APPROVAL_ACCEPT);
      active.answered.set(approval.approvalId, "allow_for_chat");
      run.resolveApproval(approval, "allow_for_chat", true);
      return;
    }
    const pending = {
      ...approval,
      expiresAt: Date.now() + active.limits.approvalMs,
    };
    const timer = setTimeout(
      () => this.settleApproval(active, pending.approvalId, "expired", true),
      active.limits.approvalMs,
    );
    active.approvals.set(pending.approvalId, {
      approval: pending,
      rpcId: request.id,
      codex,
      timer,
    });
    this.clearWatchdog(active);
    run.requestApproval(pending);
  }

  // Ends one pending approval. `reply` is false when Codex already withdrew
  // the request. Anything but an allow declines the call (cancel on stop).
  private settleApproval(
    active: Active,
    approvalId: string,
    decision: ApprovalDecision,
    reply: boolean,
  ): void {
    const wait = active.approvals.get(approvalId);
    if (!wait) return;
    clearTimeout(wait.timer);
    active.approvals.delete(approvalId);
    active.answered.set(approvalId, decision);
    const allowed = decision === "allow" || decision === "allow_for_chat";
    if (!allowed) active.denied.add(wait.approval.itemId);
    if (decision === "allow_for_chat")
      active.allowed.get(wait.approval.connector)?.add(wait.approval.tool);
    if (reply)
      wait.codex.respond(
        wait.rpcId,
        allowed
          ? APPROVAL_ACCEPT
          : decision === "cancelled"
            ? APPROVAL_CANCEL
            : APPROVAL_DECLINE,
      );
    active.run.resolveApproval(wait.approval, decision, false);
    if (!isFinished(active.run.status)) this.rearmWatchdog(active);
  }

  private endApprovals(active: Active, decision: "deny" | "cancelled"): void {
    for (const approvalId of [...active.approvals.keys()])
      this.settleApproval(active, approvalId, decision, true);
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

// Codex's built-in MCP resource tools (core/src/tools/handlers/mcp_resource),
// offered whenever any MCP server is configured.
const CODEX_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

// Classifies a failed mcpToolCall into a coarse code. The error message is read
// only to choose the bucket; it is never emitted or logged. Codex surfaces the
// approval refusal as "… requires approval …" (mcp-probe 2); a server that
// returns an error result (`isError: true`) leaves a `result` with no `error`.
function classifyToolError(item: Record<string, unknown>): ToolErrorCode {
  const error = item.error as { message?: unknown } | null | undefined;
  const message =
    error && typeof error.message === "string" ? error.message : "";
  if (/requires approval/i.test(message)) return "REFUSED";
  if (/user (rejected|cancelled) MCP tool call/i.test(message)) return "DENIED";
  if (/time ?d? ?out|timeout|deadline/i.test(message)) return "TIMEOUT";
  // An error message that is not an approval/timeout, or a server error result
  // with no typed error, is a tool error.
  if (message.length > 0 || item.result != null) return "TOOL_ERROR";
  return "UNKNOWN";
}

// Classifies a connector startup failure into a coarse reason. `failureReason`
// is the typed signal (the pin only defines `reauthenticationRequired` today,
// used for header-auth 401s); the error string is inspected only to tell an
// unreachable server from an unknown fault, and is never emitted.
function classifyConnectorFailure(
  failureReason: unknown,
  error: unknown,
): "auth" | "unreachable" | "unknown" {
  if (failureReason === "reauthenticationRequired") return "auth";
  const message = typeof error === "string" ? error : "";
  if (/401|unauthor|forbidden|reauth|invalid.?token/i.test(message))
    return "auth";
  if (
    /connect|refused|econnrefused|timed? ?out|timeout|unreachable|dns|resolve|network/i.test(
      message,
    )
  )
    return "unreachable";
  return "unknown";
}

// The in-progress call an approval request is for: the unasked call on that
// connector whose arguments equal the request's, else the only unasked call on
// it. Two candidates with no argument match is ambiguous and matches nothing.
function matchCall(
  calls: ReadonlyMap<string, ToolCall>,
  connector: string,
  toolParams: unknown,
): [string, ToolCall] | undefined {
  const open = [...calls].filter(
    ([, call]) => call.connector === connector && !call.asked,
  );
  if (toolParams !== undefined) {
    const args = canonical(toolParams);
    const exact = open.filter(([, call]) => call.args === args);
    if (exact.length > 0) return exact[0];
  }
  return open.length === 1 ? open[0] : undefined;
}

// The call's arguments as the card shows them: Codex's display list when it
// has one, else the raw arguments. Names and values are model-written, so
// they are bounded and stripped of control and bidi characters.
function approvalParams(meta: Record<string, unknown>): ApprovalParam[] {
  const raw: Array<[unknown, unknown]> = Array.isArray(meta.tool_params_display)
    ? (meta.tool_params_display as Array<Record<string, unknown>>).map((p) => [
        p?.display_name ?? p?.name,
        p?.value,
      ])
    : meta.tool_params && typeof meta.tool_params === "object"
      ? Object.entries(meta.tool_params as Record<string, unknown>).sort(
          ([a], [b]) => a.localeCompare(b),
        )
      : [];
  return raw
    .filter(([name]) => typeof name === "string" && name.length > 0)
    .slice(0, MAX_APPROVAL_PARAMS)
    .map(([name, value]) => ({
      name: bounded(String(name), MAX_APPROVAL_NAME),
      value: bounded(
        typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
        MAX_APPROVAL_VALUE,
      ),
    }));
}

function bounded(text: string, max: number): string {
  const clean = text.replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
    "",
  );
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// A stable hash of the MCP spec list (names, URLs, header names AND values,
// enabled tools and timeouts), so a rotated token or any other change yields a
// different fingerprint and forces a fresh resume. Only this hash is kept in
// memory — never the header values themselves. Specs are already name-unique
// and in request order, so no extra sorting is needed.
function mcpFingerprint(mcp: readonly McpServerSpec[]): string {
  if (mcp.length === 0) return "";
  const canonical = mcp.map((server) => ({
    name: server.name,
    url: server.url,
    headers: Object.keys(server.headers)
      .sort()
      .map((name) => [name, server.headers[name]]),
    enabledTools: server.enabledTools ? [...server.enabledTools] : null,
    toolTimeoutSec: server.toolTimeoutSec,
    startupTimeoutSec: server.startupTimeoutSec,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function toHistoryTurn(turn: Record<string, unknown>): HistoryTurn {
  const items = (turn.items ?? []) as Array<Record<string, unknown>>;
  const user = items.find((item) => item.type === "userMessage");
  const text = items
    .filter((item) => item.type === "agentMessage")
    .map((item) => String(item.text ?? ""))
    .join("\n\n");
  const ordered: HistoryItem[] = [];
  for (const item of items) {
    if (item.type === "userMessage")
      ordered.push({
        type: "input",
        clientMessageId:
          typeof item.clientId === "string" ? item.clientId : null,
      });
    else if (item.type === "agentMessage")
      ordered.push({ type: "reply", text: String(item.text ?? "") });
  }
  return {
    turnId: String(turn.id),
    status: String(turn.status),
    clientMessageId: typeof user?.clientId === "string" ? user.clientId : null,
    text,
    items: ordered,
  };
}
