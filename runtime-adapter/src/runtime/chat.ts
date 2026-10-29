import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLimits } from "../config";
import { canonical } from "../canonical";
import {
  GOAL_STATUSES,
  goalRunId,
  type ApprovalAnswer,
  type ChatGoal,
  type GoalSetRequest,
  type GoalSettings,
  type GoalStatus,
  type McpServerSpec,
  type NetworkPolicy,
  type RunContext,
  type StartRunRequest,
} from "../contract";
import {
  goalProcessArgs,
  threadResumeParams,
  SUBAGENT_MAX_WAIT_MS,
  threadStartParams,
  toolOutputTokenLimit,
  type SkillRoot,
  type CodingSettings,
} from "../codex/config";
import {
  commandScope,
  displayCommand,
  hasHiddenCharacters,
  isPush,
  MAX_COMMAND_CHARS,
  changedLines,
  previewUpdate,
  type PreviewState,
  parseChanges,
  PathMask,
  splitStreamed,
  workspacePath,
  type FileChange,
} from "../codex/activity";
import {
  catalogFingerprint,
  codingConfig,
  codingInstructions,
  modelCatalog,
  PACKAGE_BOUNDARY,
  RULES,
  type CodingSetup,
} from "../codex/coding";
import { ChatStream } from "./chat-stream";
import { SkillUseWatcher } from "./skill-use";
import { linkSkills, skillRoot } from "./skills";
import { checkedImages } from "./uploads";
import {
  CodexProcess,
  ProcessExited,
  RpcError,
  RpcTimeout,
  type BlockedRequest,
  type Notification,
  type ServerRequest,
} from "../codex/rpc";
import { classifyBlock, networkSettings } from "../codex/network";
import {
  AdapterError,
  fromCodexErrorInfo,
  runError,
  type RunError,
  type RunErrorCode,
} from "../errors";
import {
  isFinished,
  Run,
  type ActivityStatus,
  type ApprovalDecision,
  type ApprovalParam,
  type PendingApproval,
  type PlanStep,
  type RunPlan,
  type ToolErrorCode,
} from "./run";

// One chat's Codex home, process and active run. A chat has exactly one
// thread, recorded in `chat.json` the moment Codex creates it, so a retried
// first message reuses that thread instead of creating a second one.

export interface ChatHost {
  readonly binary: string;
  readonly limits: RuntimeLimits;
  // Set when the operator turned coding on: every run gets the coding profile.
  readonly coding?: CodingSetup | undefined;
  // Takes one of the manager's process slots before a goal request starts a
  // process (RUNTIME_BUSY at capacity); a no-op while the chat holds one.
  reserveSlot(chat: ChatRuntime): void;
  // Called when the chat's process slot is free again.
  releaseSlot(chat: ChatRuntime): void;
  // Registers a run Codex started for the chat's goal, like an admitted one:
  // findable by ID until it expires, and awaited by drain.
  adoptRun(run: Run, execution: Promise<void>): void;
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
// Helper events kept until the lead's item names their helper (lifecycle
// only; on the pin the item comes first, so normally none).
const STRAY_LIMIT = 200;
// Helpers one run may start in total. The concurrency cap alone does not
// bound this: a finished helper frees its slot (subagents probe).
const MAX_SUBAGENTS_PER_RUN = 6;

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
  // This turn's usage across all its model calls. Codex's `last` is only
  // the latest call, and some updates repeat it (compaction estimates,
  // rate-limit refreshes), so the turn adds the growth of the thread total.
  turnUsage: Record<string, number> | null;
  prevTotal: Record<string, unknown> | null;
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
  // Per connector, the tools that ask every time (McpServerSpec.criticalTools).
  readonly critical: Map<string, Set<string>>;
  // Coding runs only: what the member allowed for this chat (command hashes,
  // and whether every file change is allowed). Grows during the run.
  readonly coding: CodingAllows | undefined;
  // Commands and file changes in progress, so an approval request can be
  // matched to the item Codex started for it (by exact item id).
  readonly activities: Map<string, Activity>;
  // Command output not yet forwarded (see streamOutput), by item id.
  readonly outputTails: Map<string, string>;
  // apply_patch calls the model is still writing, before Codex starts their
  // file change item. Ended when anything else starts instead.
  // The value is the live preview sent so far (new files only).
  readonly writing: Map<string, PreviewState | null>;
  // Runs with skills only: reports the skills the model opens.
  skillUse: SkillUseWatcher | undefined;
  // Coding runs with a network policy: what the proxy enforces, so a request
  // it refuses can be explained (network.ts `classifyBlock`).
  readonly network: NetworkPolicy | undefined;
  // Approval requests that arrived before turn/start answered.
  readonly earlyRequests: Array<{
    codex: CodexProcess;
    request: ServerRequest;
  }>;
  // Helper agents (absent without `subAgents`), by thread id.
  readonly subAgents: StartRunRequest["subAgents"];
  readonly children: Map<string, Child>;
  // The lead's collaboration calls in flight (wait_agent above all): the
  // lead is silent through them even when no helper is running.
  readonly collabCalls: Set<string>;
  // Helper events seen before the lead's item that names the helper.
  strays: Notification[];
  // Set while the run's outcome waits for its helpers to stop.
  childrenDone: (() => void) | undefined;
  childTimer: NodeJS.Timeout | undefined;
  // The lead's latest usage update; `usage` adds the helpers to its turn.
  leadUsage: { last: unknown; total: unknown; contextWindow: unknown } | null;
}

// One helper agent: a Codex thread of its own on this process. Its usage is
// the growth of its own thread total, like the lead's turn.
interface Child {
  readonly threadId: string;
  readonly path: string;
  turnId: string | undefined;
  status: "running" | "completed" | "failed" | "stopped";
  prevTotal: Record<string, unknown> | null;
  usage: Record<string, number> | null;
  stopSent: boolean;
  archived: boolean;
  // The helper's latest answer, bounded; the lead receives it in full.
  result: string | undefined;
}

// What the member sees of a helper: a short preview while it works and its
// answer, both bounded. Its raw stream is never forwarded.
const AGENT_PREVIEW_CHARS = 240;
const AGENT_PATH_CHARS = 120;
const AGENT_RESULT_CHARS = 4000;

interface CodingAllows {
  readonly commands: Set<string>;
}

type Activity =
  | { readonly kind: "command"; readonly command: string; asked: boolean }
  | { readonly kind: "file_change"; asked: boolean };

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

type Outcome = "accept" | "decline" | "cancel";

// Answers to Codex's tool approval (`mcpServer/elicitation/request`). "Allow
// for this chat" is held here, not by Codex: its session memory is lost on
// every process restart and would let later calls run unaudited, so Codex
// is never sent `persist`.
const APPROVAL_ACCEPT = { action: "accept", content: {}, _meta: null };
const APPROVAL_DECLINE = { action: "decline", content: null, _meta: null };
const APPROVAL_CANCEL = { action: "cancel", content: null, _meta: null };
const ELICITATION = "mcpServer/elicitation/request";
const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
// Codex's answers to a command or file-change approval. "acceptForSession"
// is never sent, for the same reason MCP's `persist` is not.
const CODING_ANSWER: Record<Outcome, unknown> = {
  accept: { decision: "accept" },
  decline: { decision: "decline" },
  cancel: { decision: "cancel" },
};
const MCP_ANSWER: Record<Outcome, unknown> = {
  accept: APPROVAL_ACCEPT,
  decline: APPROVAL_DECLINE,
  cancel: APPROVAL_CANCEL,
};
// The connector name coding approvals carry. Not a valid connector slug
// (those start with a letter), so it never collides with one.
const WORKSPACE = "@workspace";
// A running command gets at least this long without other activity before
// the watchdog fails the run.
const COMMAND_WATCHDOG_MS = 10 * 60_000;
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

// A loaded thread with this goals setting, or the thread to set a goal on.
type ThreadContext = RunContext & { readonly goals?: GoalSettings };

type GoalOrigin = "user" | "model";

// A goal run's request hash. No client request hashes to it, so a start
// carrying a goal run's ID is RUN_CONFLICT.
const GOAL_RUN_HASH = "goal";

interface GoalIdentity {
  readonly createdAt: number;
  readonly objective: string;
}

const identity = (goal: ChatGoal): GoalIdentity => ({
  createdAt: goal.createdAt,
  objective: goal.objective,
});

// A lead turn that no run owns yet, and its events so far.
interface UnownedTurn {
  readonly turnId: string;
  readonly events: Notification[];
}

export class ChatRuntime {
  // True while this chat holds one of the manager's process slots.
  hasSlot = false;
  lastUsedAt = Date.now();
  // Active goal sets admitted and not yet answered. Such a set may start or
  // resume the thread, so the manager admits no run meanwhile (CHAT_BUSY).
  startingGoal = 0;
  // Goal requests admitted and not yet answered; the manager neither stops
  // this chat's process for idleness nor evicts it meanwhile.
  goalRequests = 0;
  // Goal requests reach Codex one at a time, in the order they arrived.
  private goalChain: Promise<unknown> = Promise.resolve();
  // The chat stream: goal changes and the runs Codex starts for the goal.
  readonly events: ChatStream;
  // The chat's one thread, once chat.json has been read or written.
  private threadId: string | null = null;
  // What the thread was last loaded or run with, without the input: a goal
  // run uses it. It holds credentials, so it is dropped with the process.
  private context: ThreadContext | undefined;
  // The goal Codex last reported (null: none or cleared) and whose it is.
  private goal: ChatGoal | null = null;
  private goalOrigin: GoalOrigin | null = null;
  // The goal this adapter set, by createdAt and objective (Codex goals have
  // no ID, goals probe 10), kept in chat.json so a new process or adapter
  // still knows it; undefined until chat.json is read. A set that makes a
  // goal active, or gives it an objective, makes it the adapter's; a pause
  // does not.
  private ownGoal: GoalIdentity | null | undefined;
  // Such sets in flight. Codex reports a set's goal (turnId null) right
  // after answering it, sometimes before the answer is read; such an update
  // is the set's.
  private settingOwn = 0;
  // Goal pauses sent and not yet answered. `close` waits for them, so a
  // stop that restarts the process does not end it before the pause lands.
  private readonly pauses = new Set<Promise<void>>();
  // A pause of a model-created goal is in flight.
  private pausingModelGoal = false;
  // A stop pauses the active goal: wanted until the pause is sent (the goal
  // may be reported only after the stopped run has ended), then sent, so it
  // is sent once. `origin` is "user" for a member's Stop. The next run or
  // goal set starts afresh.
  private stopPause: { origin: "user" | undefined; sent: boolean } | undefined;
  // Lead turns Codex started that no run owns yet (see onCodexNotification),
  // oldest first.
  private unowned: UnownedTurn[] = [];
  private process: CodexProcess | undefined;
  private starting: Promise<CodexProcess> | undefined;
  private closing: Promise<void> | undefined;
  private loadedThreadId: string | null = null;
  // The loaded thread's rollout file, as thread/start or thread/resume
  // reported it; null when Codex gave none.
  private rolloutPath: string | null = null;
  // sha256 of the MCP spec list (including header values) last applied to the
  // loaded thread. Only the hash is kept in memory, never the headers. A new
  // run whose fingerprint differs forces a fresh resume so the new spec (e.g. a
  // rotated token) takes effect — see `prepareThread`.
  private loadedMcpFingerprint = "";
  // sha256 of the model catalog the running process was started with ("" for
  // none). Codex reads the catalog once per process, so a different one
  // restarts the process.
  private processCatalog = "";
  // The goal budget maximum the running process was started with
  // (`goalProcessArgs`), or undefined for none.
  private processGoalMax: number | undefined;
  private active: Active | undefined;
  private readonly home: string;
  private readonly workspace: string;
  // Coding runs only: HOME and TMPDIR for commands, the one writable place
  // outside the workspace.
  private readonly scratch: string;
  // Coding runs with skills only: links to the chat's skills ($SKILLS).
  private readonly skillLinks: string;
  private readonly recordPath: string;
  private readonly catalogPath: string;
  // Hides tenant, chat and state paths in shown commands and output.
  private readonly mask: PathMask;

  constructor(
    readonly tenantId: string,
    readonly chatId: string,
    private readonly stateDir: string,
    private readonly host: ChatHost,
  ) {
    const root = join(stateDir, "t", tenantId, "c", chatId);
    this.home = join(root, "home");
    this.workspace = join(root, "workspace");
    this.scratch = join(root, "scratch");
    this.skillLinks = join(root, "skills");
    this.recordPath = join(root, "chat.json");
    this.catalogPath = join(this.home, "model-catalog.json");
    this.mask = new PathMask(
      {
        stateDir,
        chatRoot: root,
        workspace: this.workspace,
        scratch: this.scratch,
        skillLinks: this.skillLinks,
      },
      realStateDir(stateDir),
    );
    this.events = new ChatStream(host.limits.bufferEvents, () => ({
      goal: this.goal,
      origin: this.goalOrigin,
      activeRun: this.live
        ? {
            runId: this.live.run.runId,
            turnId: this.live.run.turnId,
            trigger: this.live.run.trigger,
          }
        : null,
    }));
  }

  get activeRun(): Run | undefined {
    return this.active?.run;
  }

  // The active run, unless it has just finished.
  private get live(): Active | undefined {
    const active = this.active;
    return active && !isFinished(active.run.status) ? active : undefined;
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
    const { active, done } = this.newActive(run, request);
    this.active = active;
    this.stopPause = undefined;
    // The turn Codex answered turn/start with, even if the run ended first.
    let answered: string | null = null;
    try {
      const codex = await this.prepareThread(run, request);
      active.codex = codex;
      if (request.skills?.length && this.rolloutPath) {
        active.skillUse = new SkillUseWatcher(
          this.rolloutPath,
          new Set(request.skills.map((skill) => skill.slug)),
          (slug) => run.useSkill(slug),
        );
        await active.skillUse.begin();
      }
      const images = await checkedImages(
        this.workspace,
        request.input.images ?? [],
      );
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
            // Images follow the text, each labelled by Codex with its path
            // so the model can tie it to the listed attachment.
            input: [
              { type: "text", text: request.input.text, text_elements: [] },
              ...images.map((path) => ({ type: "localImage", path })),
            ],
          },
        );
        turnId = accepted.turn.id;
        answered = turnId;
      } catch (error) {
        // Codex rejects an invalid turn/start (unknown thread, bad params)
        // before running anything; any other failure leaves it unknown.
        if (error instanceof RpcError && REJECTED.has(error.code))
          run.delivery = "none";
        if (error instanceof RpcTimeout) codex.kill();
        throw error;
      }
      if (isFinished(run.status)) return;
      // Whatever turn Codex names is this run's. When Codex had just started
      // a goal turn, it steers the input into that turn and answers with its
      // id; nothing tells the two cases apart (goals probe 8), and either
      // way the turn has exactly one run: this one.
      run.delivery = "accepted";
      run.turnId = turnId;
      run.status = active.interrupting ? "stopping" : "running";
      run.emit("run.accepted", {
        threadId: run.threadId,
        turnId,
        resumed: run.resumed,
      });
      active.wake(); // release steers waiting for acceptance
      const early = active.early.splice(0);
      this.keepUnowned(early, turnId);
      for (const n of early) this.onNotification(active, n);
      for (const { codex: from, request } of active.earlyRequests.splice(0))
        this.onApprovalRequest(active, from, request);
      if (active.interrupting) this.sendInterrupt(active);
      await done;
    } catch (error) {
      this.finish(active, "failed", this.toRunError(error, active));
    } finally {
      // A goal turn Codex started before this run's turn was accepted (or
      // instead of it) still gets a run of its own.
      if (!run.turnId) this.keepUnowned(active.early.splice(0), answered);
      this.endRun(active);
    }
  }

  // A run's state for one turn, and the promise its outcome settles.
  private newActive(
    run: Run,
    request: RunContext,
  ): { active: Active; done: Promise<void> } {
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
      turnUsage: null,
      prevTotal: null,
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
      critical: new Map(
        (request.mcp ?? []).map((s) => [s.name, new Set(s.criticalTools)]),
      ),
      calls: new Map(),
      approvals: new Map(),
      answered: new Map(),
      denied: new Set(),
      allowed: new Map(
        (request.mcp ?? []).map((s) => [s.name, new Set(s.approvedTools)]),
      ),
      coding: this.host.coding
        ? {
            commands: new Set(request.codingApprovals?.commands ?? []),
          }
        : undefined,
      activities: new Map(),
      outputTails: new Map(),
      writing: new Map(),
      skillUse: undefined,
      network: this.host.coding ? request.network : undefined,
      earlyRequests: [],
      subAgents: request.subAgents,
      children: new Map(),
      collabCalls: new Set(),
      strays: [],
      childrenDone: undefined,
      childTimer: undefined,
      leadUsage: null,
    };
    return { active, done };
  }

  // After a run's outcome: frees the chat for the next run, then gives a
  // goal turn Codex started meanwhile its run.
  private endRun(active: Active): void {
    this.clearTimers(active);
    active.wake(); // a steer may still be waiting if the run never accepted
    if (this.active === active) this.active = undefined;
    this.lastUsedAt = Date.now();
    if (!this.hasProcess) this.host.releaseSlot(this);
    this.adoptUnowned();
  }

  // Stops the active run once. A repeated stop, or one for a finished run, is
  // a no-op: Codex never answers a second interrupt sent while one is pending.
  interrupt(reason: "stopped" | RunErrorCode): void {
    const active = this.active;
    if (!active || isFinished(active.run.status) || active.interrupting) return;
    // A stop pauses the goal first, or Codex continues it with the member's
    // next turn (goals probe 6), or on the next resume (probe 9). A watchdog
    // or helper-limit stop too, without the member's origin. A shutdown does
    // not: the goal continues when the chat is resumed after the restart.
    if (reason !== "RUNTIME_SHUTDOWN") {
      this.stopPause ??= {
        origin: reason === "stopped" ? "user" : undefined,
        sent: false,
      };
      this.pauseForStop();
    }
    // The lead's turn has ended and its outcome is set; only helpers are
    // still being stopped, within stopMs. Interrupting the lead now would
    // turn a finished reply into "stopped" and restart the process.
    if (active.childrenDone) return this.stopChildren(active);
    active.interrupting = true;
    if (reason !== "stopped") active.failReason = reason;
    const run = active.run;
    run.stopRequested = true;
    if (run.status === "starting") return; // handled once the turn is accepted
    run.status = "stopping";
    this.sendInterrupt(active);
    this.stopChildren(active);
    // After the interrupt, so the model cannot act on the refusal first.
    this.endApprovals(active, "cancelled");
  }

  // Sends a stop's pause while the chat's goal is active; a goal reported
  // only later (a stop while the run resumes the thread) is paused then.
  // Written before the interrupt: Codex handles one thread's
  // thread/goal/set and turn/interrupt in the order written (both are
  // serialized by thread id), so its idle hook then finds no active goal.
  private pauseForStop(): void {
    const wanted = this.stopPause;
    if (!wanted || wanted.sent || this.goal?.status !== "active") return;
    if (this.pauseGoal(wanted.origin)) wanted.sent = true;
  }

  // `thread/goal/set {status: paused}` on the chat's thread; undefined when
  // there is no process to send it to. "user" records it as the member's
  // instruction, as the Codex TUI does when it pauses a goal.
  private pauseGoal(origin: "user" | undefined): Promise<void> | undefined {
    const codex = this.process;
    const threadId = this.threadId;
    if (!codex?.isAlive || !threadId) return undefined;
    const pause: Promise<void> = codex
      .request("thread/goal/set", {
        threadId,
        ...(origin ? { origin } : {}),
        status: "paused",
      })
      .then(
        () => undefined,
        (error: unknown) =>
          this.host.log("goal_pause_failed", {
            tenantId: this.tenantId,
            chatId: this.chatId,
            error: error instanceof Error ? error.name : typeof error,
            ...(error instanceof RpcError ? { code: error.code } : {}),
          }),
      )
      .finally(() => this.pauses.delete(pause));
    this.pauses.add(pause);
    return pause;
  }

  // The member's answer to a pending approval. First answer wins.
  answerApproval(approvalId: string, answer: ApprovalAnswer): ApprovalAnswer {
    const active = this.active;
    const wait = active?.approvals.get(approvalId);
    if (active && wait) {
      // A card that offers no Allow for this chat (push) is allowed once.
      const decision =
        answer === "allow_for_chat" && !wait.approval.allowForChat
          ? "allow"
          : answer;
      this.settleApproval(active, approvalId, decision, true);
      return decision;
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

  // Sets the chat's goal (`thread/goal/set`, origin user). Making it active
  // first starts or resumes the thread with the request's context, because
  // Codex continues a goal only on a loaded thread; Codex then starts a goal
  // turn by itself. A pause works on an unloaded thread. The caller admits an
  // active set only while no run is active.
  setGoal(request: GoalSetRequest): Promise<ChatGoal> {
    const activating = request.status === "active";
    if (activating) this.startingGoal++;
    return this.goalOp(async () => {
      this.stopPause = undefined;
      const max = request.goals.maxTokenBudget;
      let codex: CodexProcess;
      let threadId: string;
      if (request.status === "active") {
        this.host.reserveSlot(this);
        codex = await this.loadForGoal({
          ...request.run,
          goals: request.goals,
        });
        threadId = this.loadedThreadId!;
      } else {
        const recorded = await this.readRecord();
        if (!recorded) throw new AdapterError("GOAL_NOT_FOUND");
        // A set on an unloaded thread reads the process config (goals probe
        // 2): a process started without this maximum is replaced, which is
        // safe because nothing of this chat is loaded in it.
        if (
          this.process &&
          !this.active &&
          this.loadedThreadId === null &&
          this.processGoalMax !== max
        )
          await this.restartForMcpChange("goal_reload");
        this.host.reserveSlot(this);
        codex = await this.ensureProcess(max);
        threadId = recorded;
      }
      const owning = activating || request.objective !== undefined;
      if (owning) this.settingOwn++;
      let answer: { goal?: unknown };
      try {
        answer = await this.goalRequest<{ goal?: unknown }>(
          codex,
          "thread/goal/set",
          {
            threadId,
            origin: "user",
            status: request.status,
            ...(request.objective !== undefined
              ? { objective: request.objective }
              : {}),
            ...(request.tokenBudget !== undefined
              ? { tokenBudget: request.tokenBudget }
              : {}),
          },
        );
      } finally {
        if (owning) this.settingOwn--;
      }
      const goal = this.toChatGoal(answer.goal);
      if (owning) {
        this.ownGoal = identity(goal);
        await this.saveOwnGoal(this.ownGoal);
      }
      return goal;
    }).finally(() => {
      if (activating) this.startingGoal--;
    });
  }

  // The chat's goal, or null when it has none (or no thread yet). Does not
  // load the thread.
  getGoal(): Promise<ChatGoal | null> {
    return this.goalOp(async () => {
      const threadId = await this.readRecord();
      if (!threadId) return null;
      this.host.reserveSlot(this);
      const codex = await this.ensureProcess();
      const answer = await this.goalRequest<{ goal?: unknown }>(
        codex,
        "thread/goal/get",
        { threadId },
      );
      return answer.goal === null ? null : this.toChatGoal(answer.goal);
    });
  }

  // Clears the chat's goal; false when there was none. Does not load the
  // thread.
  clearGoal(): Promise<boolean> {
    return this.goalOp(async () => {
      const threadId = await this.readRecord();
      if (!threadId) return false;
      this.host.reserveSlot(this);
      const codex = await this.ensureProcess();
      const answer = await this.goalRequest<{ cleared?: unknown }>(
        codex,
        "thread/goal/clear",
        { threadId, origin: "user" },
      );
      return answer.cleared === true;
    });
  }

  private goalOp<T>(op: () => Promise<T>): Promise<T> {
    this.goalRequests++;
    const result = this.goalChain.then(op).finally(() => {
      this.goalRequests--;
      this.lastUsedAt = Date.now();
      if (!this.hasProcess && this.goalRequests === 0)
        this.host.releaseSlot(this);
    });
    this.goalChain = result.catch(() => undefined);
    return result;
  }

  private async loadForGoal(context: ThreadContext): Promise<CodexProcess> {
    try {
      return await this.prepareThread(undefined, context);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (error instanceof ThreadFailure)
        throw error.code === "THREAD_LOST"
          ? new AdapterError("THREAD_LOST")
          : new AdapterError(
              "INVALID_REQUEST",
              "run.threadId is not this chat's thread.",
            );
      this.goalFailure("thread/load", error);
    }
  }

  private async goalRequest<T>(
    codex: CodexProcess,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await codex.request<T>(method, params);
    } catch (error) {
      if (error instanceof RpcError && isMissingThread(error))
        throw new AdapterError("THREAD_LOST");
      if (error instanceof RpcError && /no goal exists/i.test(error.message))
        throw new AdapterError("GOAL_NOT_FOUND");
      this.goalFailure(method, error);
    }
  }

  // Codex's text is untrusted, so only the method and error kind are logged.
  private goalFailure(method: string, error: unknown): never {
    this.host.log("goal_request_failed", {
      tenantId: this.tenantId,
      chatId: this.chatId,
      method,
      error: error instanceof Error ? error.name : typeof error,
      ...(error instanceof RpcError ? { code: error.code } : {}),
    });
    throw new AdapterError("RUNTIME_UNAVAILABLE");
  }

  private toChatGoal(value: unknown): ChatGoal {
    const goal = chatGoal(value);
    if (goal) return goal;
    this.host.log("goal_response_invalid", {
      tenantId: this.tenantId,
      chatId: this.chatId,
    });
    throw new AdapterError("RUNTIME_UNAVAILABLE");
  }

  // Forgets the process and what it had loaded. A goal turn no run owns
  // ends with it.
  private unload(): void {
    this.process = undefined;
    this.loadedThreadId = null;
    this.loadedMcpFingerprint = "";
    this.context = undefined;
    this.unowned = [];
  }

  // Stops the process. The chat's files stay on disk for the next resume.
  // A new process waits for the old one to exit, so two never share a home.
  close(): Promise<void> {
    this.closing ??= (async () => {
      const codex =
        this.process ?? (await this.starting?.catch(() => undefined));
      this.unload();
      // A stop's pause reaches Codex before the process ends, within the
      // stop's own limit; a pause cut off there is logged as failed.
      if (this.pauses.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(this.pauses),
          new Promise((resolve) => {
            timer = setTimeout(resolve, this.host.limits.stopMs);
          }),
        ]);
        clearTimeout(timer);
      }
      await codex?.stop();
    })().finally(() => {
      this.closing = undefined;
      if (!this.hasProcess) this.host.releaseSlot(this);
    });
    return this.closing;
  }

  // Starts or resumes the chat's thread. Without a run (an active goal set),
  // the goal turn Codex then starts becomes a run (onCodexNotification).
  private async prepareThread(run: Run | undefined, request: ThreadContext) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    const coding = await this.prepareCoding(request);
    const recorded = await this.readRecord();
    if (request.threadId && !recorded) throw new ThreadFailure("THREAD_LOST");
    if (request.threadId && recorded !== request.threadId)
      throw new ThreadFailure("THREAD_MISMATCH");
    const mcp = request.mcp ?? [];
    const fingerprint = threadFingerprint(
      mcp,
      this.host.coding ? request.network : undefined,
      request.subAgents,
      request.goals,
    );
    if (
      recorded &&
      this.loadedThreadId === recorded &&
      this.loadedMcpFingerprint !== fingerprint
    )
      await this.restartForMcpChange();
    else if (
      this.process &&
      this.processCatalog !== (await this.catalogOnDisk())
    )
      await this.restartForMcpChange();
    const codex = await this.ensureProcess(request.goals?.maxTokenBudget);
    // Before thread/start or thread/resume: a goal turn the resume starts
    // runs with it.
    this.context = threadContext(request);
    if (!recorded) {
      const started = await codex.request<{
        thread: { id: string; path?: unknown };
      }>(
        "thread/start",
        threadStartParams(
          request.model,
          request.agentPrompt,
          this.workspace,
          mcp,
          coding,
          this.skillRoots(request),
          request.subAgents,
          request.goals,
        ),
      );
      await this.writeRecord(started.thread.id);
      if (run) run.threadId = started.thread.id;
      this.rolloutPath = pathOf(started.thread);
      this.loadedThreadId = started.thread.id;
      this.loadedMcpFingerprint = fingerprint;
      return codex;
    }
    if (run) run.threadId = recorded;
    // Resume when the thread is not the one loaded in this process. A changed
    // MCP spec has already restarted the process above, so it lands here too.
    if (this.loadedThreadId !== recorded) {
      try {
        const resumed = await codex.request<{ thread?: { path?: unknown } }>(
          "thread/resume",
          threadResumeParams(
            recorded,
            request.model,
            this.workspace,
            mcp,
            coding,
            request.subAgents,
            request.goals,
          ),
        );
        this.rolloutPath = pathOf(resumed.thread);
      } catch (error) {
        if (error instanceof RpcError && isMissingThread(error))
          throw new ThreadFailure("THREAD_LOST");
        throw error;
      }
      if (run && this.loadedThreadId !== recorded) run.resumed = true;
      this.loadedThreadId = recorded;
      this.loadedMcpFingerprint = fingerprint;
    }
    return codex;
  }

  // Writes the coding profile's files into the chat's Codex home before the
  // process starts: the exec-policy rules (read once per process) and a model
  // catalog for the run's model. Both are rewritten every run, so a changed
  // rule or model takes effect and nothing stale survives. Undefined when the
  // operator has not turned coding on: no files, text-only params.
  private async prepareCoding(
    request: RunContext,
  ): Promise<CodingSettings | undefined> {
    const coding = this.host.coding;
    if (!coding) return undefined;
    await mkdir(this.scratch, { recursive: true, mode: 0o700 });
    await mkdir(join(this.home, "rules"), { recursive: true, mode: 0o700 });
    await writeAtomic(join(this.home, "rules", "default.rules"), RULES);
    const catalog = modelCatalog(
      request.model,
      toolOutputTokenLimit(request.model.contextWindow),
    );
    await writeAtomic(this.catalogPath, catalog);
    if (coding.packageBoundary)
      await writeFile(coding.packageBoundary, PACKAGE_BOUNDARY, {
        flag: "wx",
        mode: 0o600,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const skills = request.skills ?? [];
    if (skills.length > 0)
      await linkSkills(this.stateDir, this.skillLinks, skills);
    const network = request.network
      ? networkSettings(request.network, {
          upstreamProxy: coding.networkTestEnv !== undefined,
        })
      : undefined;
    return {
      config: codingConfig(
        {
          stateDir: this.stateDir,
          workspace: this.workspace,
          scratch: this.scratch,
          packageBoundary: coding.packageBoundary,
          skills: this.skillRoots(request).map((skill) => skill.path),
          skillLinks: skills.length > 0 ? this.skillLinks : undefined,
          network,
        },
        coding.toolchains,
      ),
      instructions: codingInstructions(
        skills.length > 0,
        network !== undefined,
      ),
    };
  }

  // The server checked that every skill is on disk before admitting the run.
  // The slug names the root, so the catalog the model sees reads by skill.
  private skillRoots(request: RunContext): SkillRoot[] {
    return (request.skills ?? []).map((skill) => ({
      id: skill.slug,
      path: skillRoot(this.stateDir, skill.sha256),
    }));
  }

  // The fingerprint of the catalog file a new process would load, or "" when
  // coding is off or no catalog has been written yet.
  private async catalogOnDisk(): Promise<string> {
    if (!this.host.coding) return "";
    try {
      return catalogFingerprint(await readFile(this.catalogPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  // The pin applies a thread's MCP config only when it loads the thread:
  // thread/resume on a thread that is already loaded keeps the old headers
  // (verified on the pin, mcp.test.ts "rotated while the thread stays
  // loaded"). A changed spec (a refreshed token, another connector set)
  // therefore stops this chat's process so the thread is loaded afresh. The
  // slot stays held: `closing` keeps `hasProcess` true through the exit, and
  // the run starts the next process right after.
  private async restartForMcpChange(reason = "mcp_reload"): Promise<void> {
    const codex = this.process;
    this.unload();
    if (!codex) return;
    this.host.log(reason, {
      tenantId: this.tenantId,
      chatId: this.chatId,
    });
    this.closing = codex.stop().finally(() => {
      this.closing = undefined;
    });
    await this.closing;
  }

  // `goalMax` applies only to a process this call starts.
  private ensureProcess(goalMax?: number): Promise<CodexProcess> {
    if (this.process?.isAlive && !this.closing)
      return Promise.resolve(this.process);
    this.starting ??= (async () => {
      await this.closing;
      const catalog = await this.catalogOnDisk();
      const codex = new CodexProcess({
        binary: this.host.binary,
        home: this.home,
        workspace: this.workspace,
        rpcMs: this.host.limits.rpcMs,
        configArgs: [
          ...(catalog
            ? [`model_catalog_json=${JSON.stringify(this.catalogPath)}`]
            : []),
          ...goalProcessArgs(goalMax),
        ],
        networkLog: this.host.coding !== undefined,
        testEnv: this.host.coding?.networkTestEnv,
      });
      this.processCatalog = catalog;
      this.processGoalMax = goalMax;
      // For the process's life, before thread/start or thread/resume, so a
      // connector's `mcpServer/startupStatus/updated` (which the pin emits
      // during those calls, before any turn exists) reaches the run and
      // surfaces as `connector.status`.
      codex.setListener((n) => this.onCodexNotification(codex, n));
      codex.setRequestHandler((r) => this.onCodexRequest(codex, r));
      codex.onExit = () => this.onProcessExit(codex);
      codex.onBlockedRequest = (blocked) => this.onBlocked(codex, blocked);
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

  // The network proxy refused a sandbox request (rpc.ts `parseBlocked`). The
  // command already saw a refusal; the run gets one card per site and method
  // so the member can allow it for the next reply.
  private onBlocked(codex: CodexProcess, blocked: BlockedRequest): void {
    const active = this.active;
    if (!active?.network || active.codex !== codex) return;
    if (isFinished(active.run.status)) return;
    const block = classifyBlock(active.network, blocked);
    if (active.run.networkBlocked(block))
      this.host.log("network_blocked", {
        runId: active.run.runId,
        host: block.host,
        method: block.method,
        kind: block.kind,
      });
  }

  private onProcessExit(codex: CodexProcess): void {
    if (this.process === codex) this.unload();
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

  // Every notification from the chat's process. Goal changes go to the chat
  // stream; everything else goes to the active run, as before, except a lead
  // turn no run asked for. Codex started that turn for the goal (goals probe
  // 4, 9), so it becomes a run of its own. Codex runs one lead turn at a
  // time: a new one while the active run's own turn has ended (its helpers
  // are still stopping) waits until that run finishes.
  private onCodexNotification(codex: CodexProcess, n: Notification): void {
    if (codex !== this.process) return;
    const lead = this.threadId !== null && n.params.threadId === this.threadId;
    if (lead && n.method === "thread/goal/updated")
      return this.onGoalUpdated(n);
    if (lead && n.method === "thread/goal/cleared") return this.onGoalCleared();
    const turnId = lead ? turnOf(n) : undefined;
    const waiting = turnId
      ? this.unowned.find((turn) => turn.turnId === turnId)
      : undefined;
    if (waiting) return hold(waiting, n);
    const active = this.live;
    const started = n.method === "turn/started" && turnId !== undefined;
    if (
      active &&
      !(started && active.run.turnId && active.run.turnId !== turnId)
    )
      return this.onNotification(active, n);
    if (!started) return;
    this.unowned.push({ turnId, events: [n] });
    this.adoptUnowned();
  }

  // Codex's requests go to the active run, which declines any for a turn
  // that is not its own; with no run, the RPC layer refuses them.
  private onCodexRequest(codex: CodexProcess, request: ServerRequest): boolean {
    const active = this.active;
    return active ? this.onServerRequest(active, codex, request) : false;
  }

  // Lead turns among a run's early events other than its own: Codex started
  // them for the goal, so each is kept for a run of its own.
  private keepUnowned(events: Notification[], own: string | null): void {
    for (const n of events) {
      if (this.threadId === null || n.params.threadId !== this.threadId)
        continue;
      const turnId = turnOf(n);
      if (!turnId || turnId === own) continue;
      let turn = this.unowned.find((t) => t.turnId === turnId);
      if (!turn) {
        if (n.method !== "turn/started") continue;
        turn = { turnId, events: [] };
        this.unowned.push(turn);
      }
      hold(turn, n);
    }
  }

  // Gives the oldest unowned lead turn its run, once no run is live.
  private adoptUnowned(): void {
    if (this.live) return;
    const turn = this.unowned.shift();
    if (!turn) return;
    const codex = this.process;
    const context = this.context;
    const threadId = this.threadId;
    if (!codex || !context?.goals || !threadId) {
      // Only a goal chat's Codex starts turns by itself.
      this.host.log("turn_unowned", {
        tenantId: this.tenantId,
        chatId: this.chatId,
      });
      this.unowned = [];
      return;
    }
    this.startGoalRun(codex, context, threadId, turn);
  }

  // A turn Codex started for the chat's goal, as a run: the same handlers,
  // events, steer, stop and approvals as a member's run, with the context
  // the thread was last loaded or run with. Its ID is fixed by the turn.
  private startGoalRun(
    codex: CodexProcess,
    context: ThreadContext,
    threadId: string,
    turn: UnownedTurn,
  ): void {
    const { turnId } = turn;
    const run = new Run(
      goalRunId(threadId, turnId),
      this.tenantId,
      this.chatId,
      GOAL_RUN_HASH,
      this.host.limits.bufferEvents,
      null,
      "goal",
    );
    run.threadId = threadId;
    run.turnId = turnId;
    run.delivery = "accepted";
    run.status = "running";
    run.timings.dispatchedAt = run.timings.receivedAt;
    const { active, done } = this.newActive(run, context);
    active.codex = codex;
    this.active = active;
    active.wake();
    if (context.skills?.length && this.rolloutPath) {
      active.skillUse = new SkillUseWatcher(
        this.rolloutPath,
        new Set(context.skills.map((skill) => skill.slug)),
        (slug) => run.useSkill(slug),
      );
      void active.skillUse.begin();
    }
    run.emit("run.accepted", { threadId, turnId, resumed: false });
    this.host.adoptRun(
      run,
      done.finally(() => this.endRun(active)),
    );
    this.host.log("goal_run_started", {
      tenantId: this.tenantId,
      chatId: this.chatId,
      runId: run.runId,
    });
    this.events.emit("run.started", {
      runId: run.runId,
      turnId,
      trigger: "goal",
    });
    this.armWatchdog(active, context.limits.firstResponseMs);
    for (const n of turn.events) this.onNotification(active, n);
  }

  // Codex reported the goal. It is the adapter's if the adapter set it (an
  // update during such a set is that set's); otherwise the model created
  // it, and it is paused at once: it runs only once the member starts it.
  private onGoalUpdated(n: Notification): void {
    const goal = chatGoal(n.params.goal);
    if (!goal) {
      this.host.log("goal_event_invalid", {
        tenantId: this.tenantId,
        chatId: this.chatId,
      });
      return;
    }
    const turnId = typeof n.params.turnId === "string" ? n.params.turnId : null;
    if (turnId === null && this.settingOwn > 0) this.ownGoal = identity(goal);
    const own = this.ownGoal;
    const origin: GoalOrigin =
      own?.createdAt === goal.createdAt && own.objective === goal.objective
        ? "user"
        : "model";
    this.goal = goal;
    this.goalOrigin = origin;
    const data = { goal, turnId, origin };
    this.events.emit("goal.updated", data);
    // Also to the run it happened in, for the reader already attached.
    const active = this.live;
    if (
      active &&
      (turnId === null || !active.run.turnId || active.run.turnId === turnId)
    )
      active.run.emit("goal.updated", data);
    if (goal.status !== "active") return;
    // Sent while the model's turn still runs, so Codex starts no goal turn
    // after it (goals probe 7). Without the member's origin: the member did
    // not ask for this pause.
    if (origin === "model" && !this.pausingModelGoal) {
      const pause = this.pauseGoal(undefined);
      if (pause) {
        this.pausingModelGoal = true;
        void pause.finally(() => (this.pausingModelGoal = false));
      }
    }
    this.pauseForStop();
  }

  private onGoalCleared(): void {
    this.goal = null;
    this.goalOrigin = null;
    this.ownGoal = null;
    this.events.emit("goal.cleared", {});
  }

  private onNotification(active: Active, n: Notification): void {
    const run = active.run;
    if (isFinished(run.status)) return;
    // A helper's events carry its own thread id (subagents probe). Only runs
    // with helpers look, so a run without them is handled exactly as before.
    const from =
      typeof n.params.threadId === "string" ? n.params.threadId : undefined;
    if (active.subAgents && from && run.threadId && from !== run.threadId)
      return this.onOtherThread(active, from, n);
    // A connector's startup status carries no turn id and can arrive during
    // thread/start or thread/resume (before any turn). Surface it immediately;
    // it is not tied to a turn.
    if (n.method === "mcpServer/startupStatus/updated")
      return this.onConnectorStatus(active, n);
    const eventTurn = turnOf(n);
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
      case "item/commandExecution/outputDelta":
        this.activity(active);
        this.streamOutput(
          active,
          String(n.params.itemId),
          String(n.params.delta ?? ""),
        );
        return;
      case "item/agentMessage/delta":
        this.activity(active);
        run.appendText(String(n.params.itemId), String(n.params.delta ?? ""));
        return;
      case "item/fileChange/patchUpdated": {
        // The patch so far, while the model writes it: paths, a line count
        // and, for a new file, the next piece of its text.
        const itemId = String(n.params.itemId ?? "");
        if (!itemId || active.activities.has(itemId)) return;
        this.activity(active);
        const { files } = parseChanges(n.params.changes, this.workspace);
        if (files.length === 0) return;
        const next = previewUpdate(
          n.params.changes,
          this.workspace,
          active.writing.get(itemId) ?? undefined,
        );
        active.writing.set(
          itemId,
          next?.state ?? active.writing.get(itemId) ?? null,
        );
        run.fileChangeProgress(itemId, {
          files,
          lines: changedLines(n.params.changes),
          ...(next ? { preview: next.update } : {}),
        });
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = n.params.item as Record<string, unknown> | undefined;
        if (!item) return;
        if (n.method === "item/started") {
          this.endWriting(active, item.id);
          // A skill read is in the rollout before the next item starts.
          void active.skillUse?.poll();
        }
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
        if (item.type === "commandExecution" || item.type === "fileChange") {
          this.onActivityItem(active, n.method, item);
          return;
        }
        if (active.subAgents && item.type === "collabAgentToolCall") {
          const callId = String(item.id ?? "");
          if (n.method === "item/started") active.collabCalls.add(callId);
          else active.collabCalls.delete(callId);
        }
        // Codex sends no thread/started for a helper; this item names it.
        if (
          item.type === "subAgentActivity" &&
          item.kind === "started" &&
          typeof item.agentThreadId === "string"
        )
          this.registerChild(
            active,
            item.agentThreadId,
            // The task name is the model's; it is shown, so it is bounded.
            bounded(String(item.agentPath ?? ""), AGENT_PATH_CHARS),
          );
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
        const total = asRecord(usage.total);
        active.turnUsage = addTurnUsage(
          active.turnUsage,
          active.prevTotal,
          total,
          asRecord(usage.last),
        );
        active.prevTotal = total;
        active.leadUsage = {
          last: usage.last,
          total: usage.total,
          contextWindow: usage.modelContextWindow ?? null,
        };
        this.publishUsage(active);
        return;
      }
      case "turn/completed": {
        const turn = n.params.turn as Record<string, unknown>;
        // A turn whose last call was a skill read has no later item; read
        // the rollout once more before the outcome closes the run.
        if (active.skillUse)
          void active.skillUse
            .poll()
            .then(() => this.onTurnCompleted(active, turn));
        else this.onTurnCompleted(active, turn);
        return;
      }
      case "turn/plan/updated":
        // The lead's checklist, a full snapshot each time. A helper's plan
        // arrives on its own thread and never reaches this switch.
        this.activity(active);
        run.updatePlan(parsePlan(n.params));
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
    const error = turn.error as { codexErrorInfo?: unknown } | null;
    this.afterChildren(active, () => {
      if (status === "completed") return this.finish(active, "completed", null);
      if (status === "interrupted") return this.settleStopped(active);
      this.finish(active, "failed", fromCodexErrorInfo(error?.codexErrorInfo));
    });
  }

  // The run's usage: the lead's last call, thread total and context window,
  // and a turn sum that includes every helper (billing and limits). Without
  // helpers it is exactly the lead's update, as before.
  private publishUsage(active: Active): void {
    let turn = active.turnUsage;
    for (const child of active.children.values())
      if (child.usage) turn = sumUsage(turn, child.usage);
    const lead = active.leadUsage;
    active.usage = {
      last: lead ? lead.last : null,
      total: lead ? lead.total : null,
      turn,
      contextWindow: lead ? lead.contextWindow : null,
    };
    active.run.emit("usage", active.usage);
  }

  // Helper agents (Codex multi-agent V2), as observed on the pin in
  // test/codex/subagents-probe.test.ts. A helper's stream counts as run
  // activity and its usage is billed; its text, tools and connector status
  // are not the lead's and are not shown.
  private onOtherThread(
    active: Active,
    threadId: string,
    n: Notification,
  ): void {
    const child = active.children.get(threadId);
    if (child) return this.onChildNotification(active, child, n);
    if (active.strays.length < STRAY_LIMIT && !n.method.endsWith("/delta"))
      active.strays.push(n);
  }

  private registerChild(active: Active, threadId: string, path: string): void {
    if (!active.subAgents || active.children.has(threadId)) return;
    const child: Child = {
      threadId,
      path,
      turnId: undefined,
      status: "running",
      prevTotal: null,
      usage: null,
      stopSent: false,
      archived: false,
      result: undefined,
    };
    active.children.set(threadId, child);
    active.run.startAgent(threadId, path);
    this.host.log("subagent_started", {
      runId: active.run.runId,
      count: active.children.size,
    });
    const early = active.strays.filter((n) => n.params.threadId === threadId);
    active.strays = active.strays.filter((n) => n.params.threadId !== threadId);
    for (const n of early) this.onChildNotification(active, child, n);
    if (active.children.size > MAX_SUBAGENTS_PER_RUN) {
      this.host.log("subagent_limit", { runId: active.run.runId });
      this.interrupt("SUBAGENT_LIMIT");
    }
  }

  private onChildNotification(
    active: Active,
    child: Child,
    n: Notification,
  ): void {
    switch (n.method) {
      case "turn/started": {
        const turn = n.params.turn as { id?: unknown } | undefined;
        if (typeof turn?.id === "string") child.turnId = turn.id;
        child.status = "running";
        child.stopSent = false;
        // A stop asked for before this turn started still applies.
        if (active.interrupting || active.childrenDone)
          this.stopChild(active, child);
        active.run.agentActivity(child.threadId);
        return this.activity(active);
      }
      case "item/started":
      case "item/completed": {
        this.activity(active);
        const item = n.params.item as Record<string, unknown> | undefined;
        // Connector and tool names come from the chat's own spec.
        if (n.method === "item/started" && item?.type === "mcpToolCall")
          return active.run.agentActivity(
            child.threadId,
            bounded(
              `${String(item.server ?? "")}: ${String(item.tool ?? "")}`,
              AGENT_PREVIEW_CHARS,
            ),
          );
        if (n.method === "item/completed" && item?.type === "agentMessage") {
          const text = String(item.text ?? "");
          if (!text.trim()) return;
          child.result = bounded(text, AGENT_RESULT_CHARS);
          active.run.agentActivity(
            child.threadId,
            bounded(text, AGENT_PREVIEW_CHARS),
          );
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = n.params.tokenUsage as
          Record<string, unknown> | undefined;
        if (!usage) return;
        const total = asRecord(usage.total);
        child.usage = addTurnUsage(
          child.usage,
          child.prevTotal,
          total,
          asRecord(usage.last),
        );
        child.prevTotal = total;
        return this.publishUsage(active);
      }
      case "turn/completed": {
        const turn = n.params.turn as { status?: unknown } | undefined;
        child.status =
          turn?.status === "completed"
            ? "completed"
            : turn?.status === "interrupted"
              ? "stopped"
              : "failed";
        this.host.log("subagent_finished", {
          runId: active.run.runId,
          status: child.status,
        });
        active.run.completeAgent(
          child.threadId,
          child.status,
          child.result,
          child.usage,
        );
        if (active.childrenDone && !this.hasRunningChild(active))
          this.releaseChildren(active);
        return;
      }
      default:
        if (n.method.startsWith("item/")) this.activity(active);
    }
  }

  private hasRunningChild(active: Active): boolean {
    for (const child of active.children.values())
      if (child.status === "running") return true;
    return false;
  }

  // Interrupting the lead does not stop its helpers (probe), so each one is
  // interrupted on its own turn.
  private stopChildren(active: Active): void {
    for (const child of active.children.values()) this.stopChild(active, child);
  }

  private stopChild(active: Active, child: Child): void {
    const codex = active.codex;
    if (child.status !== "running" || !child.turnId || child.stopSent) return;
    if (!codex?.isAlive) return;
    child.stopSent = true;
    void codex
      .request("turn/interrupt", {
        threadId: child.threadId,
        turnId: child.turnId,
      })
      .catch(() => undefined);
  }

  // Archived once the run settles, so nothing of a helper runs on.
  private closeChildren(active: Active): void {
    const codex = active.codex;
    for (const child of active.children.values()) {
      if (child.archived) continue;
      child.archived = true;
      if (codex?.isAlive)
        void codex
          .request("thread/archive", { threadId: child.threadId })
          .catch(() => undefined);
    }
  }

  // The run settles only once no helper is running. A helper still working
  // when the lead's turn ends would be billed work nobody sees (its answer
  // never reaches the next reply, probe), so it is stopped first; the outcome
  // waits at most `stopMs` for that.
  private afterChildren(active: Active, outcome: () => void): void {
    if (active.childrenDone) return;
    if (!this.hasRunningChild(active)) {
      this.closeChildren(active);
      return outcome();
    }
    active.childrenDone = outcome;
    this.clearWatchdog(active);
    this.stopChildren(active);
    active.childTimer = setTimeout(() => {
      this.host.log("subagent_stop_timeout", { runId: active.run.runId });
      this.releaseChildren(active);
    }, this.host.limits.stopMs);
  }

  private releaseChildren(active: Active): void {
    const outcome = active.childrenDone;
    if (!outcome) return;
    active.childrenDone = undefined;
    if (active.childTimer) clearTimeout(active.childTimer);
    active.childTimer = undefined;
    this.endChildren(active);
    this.closeChildren(active);
    outcome();
  }

  // Helpers still running when the run ends are reported stopped: their
  // own turn/completed would arrive after the run's last event.
  private endChildren(active: Active): void {
    for (const child of active.children.values()) {
      if (child.status !== "running") continue;
      child.status = "stopped";
      this.host.log("subagent_finished", {
        runId: active.run.runId,
        status: child.status,
      });
      active.run.completeAgent(
        child.threadId,
        "stopped",
        child.result,
        child.usage,
      );
    }
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

  // Anything Codex starts ends the progress of patches still being written:
  // a call that becomes its file change item continues as that item, and one
  // Codex rejected (an unparsable patch) never will.
  private endWriting(active: Active, startedId: unknown): void {
    for (const itemId of active.writing.keys())
      if (itemId !== startedId) active.run.fileChangeProgress(itemId, "ended");
    active.writing.clear();
  }

  // Forwards command output with places masked (see splitStreamed).
  private streamOutput(
    active: Active,
    itemId: string,
    delta: string,
    end = false,
  ): void {
    const text = (active.outputTails.get(itemId) ?? "") + delta;
    const { shown, tail } = splitStreamed(this.mask, text, end);
    if (tail) active.outputTails.set(itemId, tail);
    else active.outputTails.delete(itemId);
    if (shown) active.run.appendOutput(itemId, shown);
  }

  // Maps a commandExecution or fileChange item to activity events. Started
  // items are kept so the approval request Codex sends next can be matched to
  // them by item id.
  private onActivityItem(
    active: Active,
    method: string,
    item: Record<string, unknown>,
  ): void {
    const run = active.run;
    const itemId = String(item.id ?? "");
    if (!itemId) return;
    this.activity(active);
    if (item.type === "commandExecution") {
      const raw = String(item.command ?? "");
      const command = this.mask.apply(displayCommand(raw));
      if (method === "item/started") {
        if (!active.activities.has(itemId))
          active.activities.set(itemId, {
            kind: "command",
            command: raw,
            asked: false,
          });
        run.startCommand(itemId, command);
        return;
      }
      active.activities.delete(itemId);
      this.streamOutput(active, itemId, "", true);
      run.completeCommand(
        itemId,
        command,
        activityStatus(item.status),
        typeof item.exitCode === "number" ? item.exitCode : undefined,
        typeof item.durationMs === "number"
          ? Math.round(item.durationMs)
          : undefined,
        typeof item.aggregatedOutput === "string"
          ? this.mask.apply(item.aggregatedOutput)
          : undefined,
      );
      return;
    }
    const { files } = parseChanges(item.changes, this.workspace);
    if (method === "item/started") {
      if (!active.activities.has(itemId))
        active.activities.set(itemId, { kind: "file_change", asked: false });
      run.startFileChange(itemId, files);
      return;
    }
    active.activities.delete(itemId);
    run.completeFileChange(itemId, files, activityStatus(item.status));
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
    if (active.interrupting || active.childrenDone) return;
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
    if (active.run.inFlightCommandCount > 0)
      ms = Math.max(ms, COMMAND_WATCHDOG_MS);
    // The lead is silent while it waits on a helper, or in wait_agent with
    // none running; a wait ends within SUBAGENT_MAX_WAIT_MS either way.
    if (this.hasRunningChild(active) || active.collabCalls.size > 0)
      ms = Math.max(ms, SUBAGENT_MAX_WAIT_MS + TOOL_WATCHDOG_GRACE_MS);
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
    if (active.childTimer) clearTimeout(active.childTimer);
    active.childTimer = undefined;
  }

  private finish(
    active: Active,
    status: "completed" | "stopped" | "failed",
    error: RunError | null,
  ): void {
    if (isFinished(active.run.status)) return;
    // Nothing of a helper outlives the run, on paths that did not wait too.
    this.stopChildren(active);
    this.endChildren(active);
    this.closeChildren(active);
    // Before the terminal event, so each approval's end is recorded.
    this.endApprovals(active, "cancelled");
    this.clearTimers(active);
    // A stopped command's last partial line.
    for (const itemId of [...active.outputTails.keys()])
      this.streamOutput(active, itemId, "", true);
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
    const coding =
      this.host.coding !== undefined &&
      (request.method === COMMAND_APPROVAL || request.method === FILE_APPROVAL);
    if (request.method !== ELICITATION && !coding) return false;
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
    if (request.method !== ELICITATION)
      return this.onCodingApproval(active, codex, request);
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
    // Helpers gather, the lead acts: a helper never changes data.
    if (
      typeof params.threadId === "string" &&
      active.children.has(params.threadId)
    )
      return decline("helper_write");
    if (params.threadId !== run.threadId || params.turnId !== run.turnId)
      return decline("other_turn");
    if (!active.mcpByName.has(connector)) return decline("unknown_connector");
    const match = matchCall(active.calls, connector, meta.tool_params);
    if (!match) return decline("unmatched");
    const [itemId, call] = match;
    call.asked = true;
    const critical = active.critical.get(connector)?.has(call.tool) === true;
    const approval = {
      approvalId: `ap_${randomUUID()}`,
      itemId,
      kind: "mcp" as const,
      connector,
      tool: call.tool,
      params: approvalParams(meta),
      allowForChat: !critical,
    };
    // Once a helper ran, its result may carry injected text that steers the
    // lead, so every write in the run asks, even one allowed for the chat.
    if (
      !critical &&
      active.children.size === 0 &&
      active.allowed.get(connector)?.has(call.tool)
    )
      return this.autoAllow(active, codex, request, approval);
    this.awaitMember(active, codex, request, approval);
  }

  // A command or file change waiting for approval. Matched to the item Codex
  // started for it; anything that does not match exactly, or that the card
  // could not show faithfully, is declined.
  private onCodingApproval(
    active: Active,
    codex: CodexProcess,
    request: ServerRequest,
  ): void {
    const run = active.run;
    const { params } = request;
    const decline = (reason: string) => {
      this.host.log("approval_declined", { runId: run.runId, reason });
      codex.respond(request.id, CODING_ANSWER.decline);
    };
    const coding = active.coding;
    if (!coding) return decline("coding_off");
    if (isFinished(run.status) || active.interrupting)
      return decline("run_ended");
    // A helper writes files and runs ordinary commands in the shared sandbox
    // without asking; only a rule-matched command (git push/reset/clean)
    // reaches here. Those publish or destroy history, so a helper never runs
    // one unsupervised — the lead makes every such change (Option B, matching
    // the MCP helper-write guard in onApprovalRequest).
    if (
      typeof params.threadId === "string" &&
      active.children.has(params.threadId)
    )
      return decline("helper_command");
    if (params.threadId !== run.threadId || params.turnId !== run.turnId)
      return decline("other_turn");
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const item = active.activities.get(itemId);
    if (!item || item.asked) return decline("unmatched");
    // A second callback for one item (stdin, sub-commands) has its own id.
    if (params.approvalId != null) return decline("sub_approval");

    let approval: Omit<PendingApproval, "expiresAt">;
    if (request.method === COMMAND_APPROVAL) {
      if (item.kind !== "command") return decline("unmatched");
      // The card cannot show network access or extra permissions yet.
      if (params.kind !== undefined && params.kind !== "command")
        return decline("unsupported_kind");
      if (params.networkApprovalContext != null) return decline("network");
      if (params.additionalPermissions != null)
        return decline("additional_permissions");
      const raw = typeof params.command === "string" ? params.command : "";
      if (raw !== item.command) return decline("unmatched");
      if (raw.length > MAX_COMMAND_CHARS) return decline("too_long");
      if (hasHiddenCharacters(raw)) return decline("hidden_characters");
      const push = isPush(raw);
      const scope = commandScope(raw);
      approval = {
        approvalId: `ap_${randomUUID()}`,
        itemId,
        kind: "command",
        connector: WORKSPACE,
        tool: push ? "push" : "command",
        params: [
          { name: "command", value: this.mask.apply(displayCommand(raw)) },
          ...(typeof params.cwd === "string"
            ? [
                {
                  name: "cwd",
                  value: workspacePath(params.cwd, this.workspace),
                },
              ]
            : []),
        ],
        allowForChat: !push,
        ...(push ? {} : { scope }),
      };
      item.asked = true;
      if (!push && coding.commands.has(scope))
        return this.autoAllow(active, codex, request, approval);
    } else {
      // Codex asks about a patch only when it writes outside the chat's
      // files, and an allowed one is written outside the sandbox (coding
      // probe 2026-10-22). The coding policy has Codex refuse those itself
      // (`sandbox_approval: false`); this guards a policy change.
      return decline("outside_workspace");
    }
    this.awaitMember(active, codex, request, approval);
  }

  // Answers from a standing Allow for this chat: no card, but the approval is
  // still recorded (auto) for the audit.
  private autoAllow(
    active: Active,
    codex: CodexProcess,
    request: ServerRequest,
    approval: Omit<PendingApproval, "expiresAt">,
  ): void {
    codex.respond(request.id, answerFor(approval.kind, "accept"));
    active.answered.set(approval.approvalId, "allow_for_chat");
    const { diff: _diff, diffTruncated: _cut, ...record } = approval;
    active.run.resolveApproval(record, "allow_for_chat", true);
  }

  private awaitMember(
    active: Active,
    codex: CodexProcess,
    request: ServerRequest,
    approval: Omit<PendingApproval, "expiresAt">,
  ): void {
    const pending: PendingApproval = {
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
    active.run.requestApproval(pending);
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
    const { approval } = wait;
    if (!allowed) active.denied.add(approval.itemId);
    if (decision === "allow_for_chat") {
      if (approval.kind === "mcp")
        active.allowed.get(approval.connector)?.add(approval.tool);
      else if (approval.scope && approval.allowForChat)
        active.coding?.commands.add(approval.scope);
    }
    if (reply)
      wait.codex.respond(
        wait.rpcId,
        answerFor(
          approval.kind,
          allowed ? "accept" : decision === "cancelled" ? "cancel" : "decline",
        ),
      );
    const {
      diff: _diff,
      diffTruncated: _cut,
      expiresAt: _at,
      ...record
    } = approval;
    active.run.resolveApproval(record, decision, false);
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
        ownGoal?: unknown;
      };
      if (typeof record.threadId !== "string") return null;
      this.threadId = record.threadId;
      // Once: later, memory is ahead of the file.
      if (this.ownGoal === undefined)
        this.ownGoal = goalIdentity(record.ownGoal);
      return record.threadId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // Write-then-rename so a crash never leaves a half-written record.
  private async writeRecord(threadId: string): Promise<void> {
    await this.saveRecord({ threadId, createdAt: new Date().toISOString() });
    this.threadId = threadId;
  }

  // Records the goal this adapter set next to the thread. Goal requests
  // reach here one at a time (goalOp). A failed write is logged, not
  // thrown: Codex already has the goal, and should the adapter restart,
  // the goal then reads as the model's and is paused, never run unasked.
  private async saveOwnGoal(own: GoalIdentity): Promise<void> {
    try {
      const record = JSON.parse(await readFile(this.recordPath, "utf8")) as {
        threadId: string;
      };
      await this.saveRecord({ ...record, ownGoal: own });
    } catch (error) {
      this.host.log("chat_record_failed", {
        tenantId: this.tenantId,
        chatId: this.chatId,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async saveRecord(record: Record<string, unknown>): Promise<void> {
    const temp = `${this.recordPath}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, this.recordPath);
  }
}

// A goal identity read back from chat.json; null when absent or malformed.
function goalIdentity(value: unknown): GoalIdentity | null {
  if (!value || typeof value !== "object") return null;
  const { createdAt, objective } = value as Record<string, unknown>;
  return typeof createdAt === "number" && typeof objective === "string"
    ? { createdAt, objective }
    : null;
}

// The turn a notification is about: `turnId`, or `turn.id` on turn events.
function turnOf(n: Notification): string | undefined {
  if (typeof n.params.turnId === "string") return n.params.turnId;
  const turn = n.params.turn as { id?: unknown } | undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}

// Bounded like a run's early events: only deltas are dropped past the cap.
function hold(turn: UnownedTurn, n: Notification): void {
  if (turn.events.length < EARLY_LIMIT || !n.method.endsWith("/delta"))
    turn.events.push(n);
}

// A request's thread settings, without a run's own IDs and input.
function threadContext(
  request: ThreadContext & Partial<StartRunRequest>,
): ThreadContext {
  const {
    runId: _run,
    tenantId: _tenant,
    chatId: _chat,
    input: _input,
    ...context
  } = request;
  return context;
}

function answerFor(kind: PendingApproval["kind"], outcome: Outcome): unknown {
  return kind === "mcp" ? MCP_ANSWER[outcome] : CODING_ANSWER[outcome];
}

function activityStatus(raw: unknown): Exclude<ActivityStatus, "inProgress"> {
  return raw === "completed"
    ? "completed"
    : raw === "declined"
      ? "declined"
      : "failed";
}

// Write-then-rename, so Codex never reads a half-written file.
function pathOf(thread: { path?: unknown } | undefined): string | null {
  return typeof thread?.path === "string" && thread.path ? thread.path : null;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
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

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Codex's goal (protocol ThreadGoal) in the contract's shape, without the
// thread ID; undefined when Codex sent something else.
export function chatGoal(value: unknown): ChatGoal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  if (
    typeof g.objective !== "string" ||
    !GOAL_STATUSES.includes(g.status as GoalStatus) ||
    !(g.tokenBudget === null || count(g.tokenBudget)) ||
    !count(g.tokensUsed) ||
    !count(g.timeUsedSeconds) ||
    !count(g.createdAt) ||
    !count(g.updatedAt)
  )
    return undefined;
  return {
    objective: g.objective,
    status: g.status as GoalStatus,
    tokenBudget: g.tokenBudget as number | null,
    tokensUsed: g.tokensUsed,
    timeUsedSeconds: g.timeUsedSeconds,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

// Bounds for the model-authored checklist (Codex `update_plan`). Truncated,
// never rejected: Codex never rejects a plan, so neither do we.
export const PLAN_MAX_STEPS = 50;
export const PLAN_STEP_CHARS = 500;
export const PLAN_EXPLANATION_CHARS = 2000;
const PLAN_STATUSES = new Set(["pending", "inProgress", "completed"]);

// `turn/plan/updated` params ({ explanation, plan: [{ step, status }] }) to
// a bounded plan. Malformed steps are dropped; a blank explanation is null.
export function parsePlan(params: Record<string, unknown>): RunPlan {
  const raw = Array.isArray(params.plan) ? params.plan : [];
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (steps.length >= PLAN_MAX_STEPS) break;
    const { step, status } = asRecord(entry);
    if (typeof step !== "string" || typeof status !== "string") continue;
    if (!PLAN_STATUSES.has(status)) continue;
    const text = bounded(step, PLAN_STEP_CHARS).trim();
    if (!text) continue;
    steps.push({ step: text, status: status as PlanStep["status"] });
  }
  const explanation =
    typeof params.explanation === "string"
      ? bounded(params.explanation, PLAN_EXPLANATION_CHARS).trim()
      : "";
  return { explanation: explanation || null, steps };
}

function bounded(text: string, max: number): string {
  const clean = text.replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
    "",
  );
  if (clean.length <= max) return clean;
  // Never keep half of a surrogate pair (an emoji split by the cut).
  const cut = /[\uD800-\uDBFF]/.test(clean[max - 2] ?? "") ? max - 2 : max - 1;
  return `${clean.slice(0, cut)}…`;
}

// A stable hash of the MCP spec list (names, URLs, header names AND values,
// enabled tools and timeouts), so a rotated token or any other change yields a
// different fingerprint and forces a fresh resume. Only this hash is kept in
// memory — never the header values themselves. Specs are already name-unique
// and in request order, so no extra sorting is needed.
// The network policy (tokens included) is part of it: the pin starts a
// thread's network proxy when it loads the thread, so a changed policy needs
// a fresh load too. So are the helper and goal settings: Codex reads them
// when it loads the thread.
function threadFingerprint(
  mcp: readonly McpServerSpec[],
  network: NetworkPolicy | undefined,
  subAgents?: StartRunRequest["subAgents"],
  goals?: GoalSettings,
): string {
  const base = mcpFingerprint(mcp);
  if (!network && !subAgents && !goals) return base;
  const hash = createHash("sha256").update(base);
  if (network) hash.update(JSON.stringify(network));
  if (subAgents) hash.update(`subAgents:${subAgents.maxConcurrent}`);
  if (goals) hash.update(`goals:${goals.maxTokenBudget}`);
  return hash.digest("hex");
}

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

const USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

// The field-wise sum of two usage records (a lead turn and a helper).
export function sumUsage(
  a: Record<string, number> | null,
  b: Record<string, number>,
): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const field of USAGE_FIELDS)
    sum[field] = (a?.[field] ?? 0) + (b[field] ?? 0);
  return sum;
}

// Adds one tokenUsage update to the turn. The growth since the previous
// update is what was spent; the turn's first update has no previous total,
// so its `last` is that growth. A total that shrank (Codex resets it when
// the context is full) adds nothing.
export function addTurnUsage(
  sum: Record<string, number> | null,
  prevTotal: Record<string, unknown> | null,
  total: Record<string, unknown>,
  last: Record<string, unknown>,
): Record<string, number> {
  const next: Record<string, number> = {};
  const growth: Record<string, number> = {};
  let shrank = false;
  for (const field of USAGE_FIELDS) {
    next[field] = sum?.[field] ?? 0;
    const d = prevTotal
      ? tokens(total[field]) - tokens(prevTotal[field])
      : tokens(last[field]);
    if (d < 0) shrank = true;
    growth[field] = d;
  }
  if (!shrank) for (const field of USAGE_FIELDS) next[field]! += growth[field]!;
  return next;
}

// The state directory's real path when it differs (a symlinked /tmp or
// /var on macOS): `pwd -P` and some tools print that spelling.
function realStateDir(stateDir: string): string[] {
  try {
    const real = realpathSync(stateDir);
    return real === stateDir ? [] : [real];
  } catch {
    return [];
  }
}
