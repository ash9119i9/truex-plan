import type { Runtime } from "../runtime/client";
import type { Redactor } from "../telemetry/redact";
import { HttpError } from "../errors";
import { errorFields, log } from "../../../shared/logging";
import { ALLOW_FOR_CHAT, AUTO_MODE_REASON } from "../../../shared/contracts";
import type { DomainType, DomainEvent } from "../../../shared/contracts";
import {
  approvalMode as parseMode,
  AUTO_MODE_NOTE,
  GRANT,
  findTool,
  grantKey,
  indexTools,
  isToolQuestion,
  parseToolQuestion,
  withChatGrant,
  type ToolRef,
} from "./approval-policy";
import {
  autoAnswer,
  defaults,
  recommendedOption,
  responseSchema,
  validateResponse,
  type ServerMethod,
} from "../protocol/requests";
import type { Thread, Pending, ModeState } from "./state";
interface ApprovalContext {
  runtime: Runtime;
  redactor: Redactor;
  generation(): string;
  thread(id: string): Thread;
  isHelper(id: string): boolean;
  watch(t: Thread): void;
  emit(
    t: Thread,
    type: DomainType,
    data: any,
    turnId?: string,
    itemId?: string,
  ): DomainEvent;
}
export class ApprovalCoordinator {
  // Approval modes per root conversation; see ModeState.
  readonly modes = new Map<string, ModeState>();
  constructor(
    private readonly context: ApprovalContext,
    readonly requestTimeoutMs: number,
  ) {}
  request(msg: { id: string | number; method: string; params: any }) {
    const method = msg.method as ServerMethod;
    const threadId = msg.params.threadId || msg.params.conversationId;
    if (!threadId) {
      this.context.runtime.respond(msg.id, undefined, {
        code: -32602,
        message: "Cannot attribute request to a thread",
      });
      return;
    }
    const t = this.context.thread(threadId),
      requestId = `${this.context.generation()}-${typeof msg.id}-${msg.id}`;
    const pending: Pending = {
      requestId,
      rawId: msg.id,
      method,
      detail: this.context.redactor.clean(msg.params),
      expiresAt: new Date(Date.now() + this.requestTimeoutMs).toISOString(),
      responseSchema: responseSchema(method),
      timer: setTimeout(() => {
        // An unanswered question proceeds with its recommended option.
        const auto =
          method === "item/tool/requestUserInput"
            ? autoAnswer(pending.detail)
            : null;
        if (auto) this.settle(t, pending, auto, "auto-recommended");
        else this.settle(t, pending, defaults[method], "expired");
      }, this.requestTimeoutMs),
    };
    t.pending.set(requestId, pending);
    this.context.watch(t);
    // A chat with an approval mode may answer before anyone is asked.
    if (method === "item/tool/requestUserInput" && this.modes.has(t.id)) {
      pending.detail = withChatGrant(pending.detail);
      pending.hidden = true;
      void this.review(t, pending);
      return;
    }
    const { timer, rawId, ...publicRequest } = pending;
    this.context.emit(
      t,
      "approval.requested",
      publicRequest,
      msg.params.turnId,
      msg.params.itemId,
    );
  }

  // Sets a root conversation's approval mode; absent leaves it unchanged.
  setMode(id: string, mode: unknown, heuristic: unknown) {
    if (mode === undefined) return;
    const next = parseMode(mode);
    const state = this.modes.get(id);
    if (!state) {
      this.modes.set(id, {
        mode: next,
        heuristic: heuristic === true,
        grants: new Set(),
      });
      return;
    }
    state.mode = next;
    if (heuristic !== undefined && (heuristic === true) !== state.heuristic) {
      state.heuristic = heuristic === true;
      state.tools = undefined;
    }
  }

  setApprovalMode(id: string, mode: unknown) {
    const t = this.context.thread(id);
    if (this.context.isHelper(id))
      throw new HttpError(409, "Helper agents follow their conversation");
    const next = parseMode(mode);
    const state = this.modes.get(id);
    if (state) state.mode = next;
    else
      this.modes.set(id, { mode: next, heuristic: false, grants: new Set() });
    this.reevaluate(t);
    return { mode: next };
  }

  // Runs the chat's mode again over its waiting questions.
  reevaluate(t: Thread) {
    if (!this.modes.has(t.id)) return;
    for (const p of [...t.pending.values()])
      if (p.method === "item/tool/requestUserInput") void this.review(t, p);
  }

  // Answers a request under the chat's mode, or shows it to the user.
  private async review(t: Thread, p: Pending) {
    const run = (p.reviews = (p.reviews ?? 0) + 1);
    let decision: { result: any; reason: string } | null = null;
    try {
      decision = await this.decide(t.id, p.detail);
      if (decision) validateResponse(p.method, decision.result);
    } catch (e) {
      // A failed lookup or an invalid answer never allows anything.
      log("debug", "approval mode decision failed; asking the user", {
        threadId: t.id,
        requestId: p.requestId,
        ...errorFields(e),
      });
      decision = null;
    }
    if (!t.pending.has(p.requestId) || p.reviews !== run) return;
    if (decision) this.settle(t, p, decision.result, decision.reason);
    else if (p.hidden) {
      p.hidden = false;
      const { timer, rawId, hidden, reviews, ...publicRequest } = p;
      this.context.emit(
        t,
        "approval.requested",
        publicRequest,
        typeof p.detail?.turnId === "string" ? p.detail.turnId : undefined,
        typeof p.detail?.itemId === "string" ? p.detail.itemId : undefined,
      );
    }
  }

  // The mode's answer for every question in a request, or null to ask.
  // Plan approval and secret questions always ask; a chat grant allows its
  // tool in any mode. Tools are only ever sent "Allow".
  private async decide(id: string, detail: any) {
    const state = this.modes.get(id);
    if (!state) return null;
    const mode = state.mode;
    const questions: any[] = Array.isArray(detail?.questions)
      ? detail.questions
      : [];
    if (!questions.length) return null;
    const answers: Record<string, { answers: string[] }> = {};
    let granted = true;
    for (const q of questions) {
      if (typeof q?.id !== "string" || q.isSecret === true) return null;
      if (q.id === "plan_approval") return null;
      if (isToolQuestion(q)) {
        const ref = parseToolQuestion(q.question);
        const offered =
          Array.isArray(q.options) &&
          q.options.some((o: any) => o?.label === "Allow");
        if (!ref || !offered) return null;
        answers[q.id] = { answers: ["Allow"] };
        if (state.grants.has(grantKey(ref))) continue;
        granted = false;
        if (mode === "auto") continue;
        if (mode === "readOnly" && (await this.readOnly(id, state, ref)))
          continue;
        return null;
      }
      granted = false;
      const pick = mode === "auto" ? recommendedOption(q) : null;
      if (!pick) return null;
      answers[q.id] = { answers: [pick, AUTO_MODE_NOTE] };
    }
    return {
      result: { answers },
      reason: AUTO_MODE_REASON + (granted ? GRANT : mode),
    };
  }

  // Only readOnlyHint === true (or the opt-in name heuristic) counts; an
  // unknown tool refreshes the inventory once, then asks.
  private async readOnly(id: string, state: ModeState, ref: ToolRef) {
    const hit =
      findTool(await this.toolIndex(id, state, false), ref) ??
      findTool(await this.toolIndex(id, state, true), ref);
    return hit?.readOnly === true;
  }

  private toolIndex(id: string, state: ModeState, refresh: boolean) {
    if (refresh || !state.tools) {
      const load = this.listTools(id, state.heuristic);
      state.tools = load;
      // A failed lookup is retried by the next request.
      load.catch(() => {
        if (state.tools === load) state.tools = undefined;
      });
    }
    return state.tools!;
  }

  private async listTools(id: string, heuristic: boolean) {
    const statuses: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.context.runtime.request(
        "mcpServerStatus/list",
        {
          threadId: id,
          detail: "toolsAndAuthOnly",
          ...(cursor ? { cursor } : {}),
        },
      );
      if (!Array.isArray(result?.data))
        throw new Error("Invalid MCP server status");
      statuses.push(...result.data);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) break;
    }
    return indexTools(statuses, heuristic);
  }

  // "Allow for this chat": remembers the tool and returns what Codex gets
  // instead ("Allow"), or undefined when the answer grants nothing.
  private grant(t: Thread, p: Pending, result: any) {
    const state = this.modes.get(t.id);
    if (!state || p.method !== "item/tool/requestUserInput") return undefined;
    let wire: any;
    for (const q of Array.isArray(p.detail?.questions)
      ? p.detail.questions
      : []) {
      const values = result?.answers?.[q?.id]?.answers;
      if (!isToolQuestion(q) || !Array.isArray(values)) continue;
      if (!values.includes(ALLOW_FOR_CHAT)) continue;
      const ref = parseToolQuestion(q.question);
      if (!ref) continue;
      state.grants.add(grantKey(ref));
      wire ??= structuredClone(result);
      wire.answers[q.id] = {
        answers: values.map((v: unknown) =>
          v === ALLOW_FOR_CHAT ? "Allow" : v,
        ),
      };
    }
    return wire;
  }

  answer(id: string, requestId: string, result: unknown) {
    const t = this.context.thread(id),
      pending = t.pending.get(requestId);
    if (!pending)
      throw new HttpError(
        409,
        "Request is already resolved or belongs to a previous runtime",
        "STALE_REQUEST",
      );
    validateResponse(pending.method, result);
    const wire = this.grant(t, pending, result);
    this.settle(t, pending, result, "user", true, wire);
    // A new grant may cover requests that are still waiting.
    if (wire !== undefined) this.reevaluate(t);
    return { ok: true };
  }

  settle(
    t: Thread,
    p: Pending,
    result: any,
    reason: string,
    reply = true,
    // Sent to the runtime instead of result, which stays the recorded answer.
    wire?: unknown,
  ) {
    if (!t.pending.has(p.requestId)) return;
    if (reply) {
      const response = wire === undefined ? result : wire;
      try {
        this.context.runtime.respond(p.rawId, response);
      } catch {
        reason = "runtime-unavailable";
      }
    }
    clearTimeout(p.timer);
    t.pending.delete(p.requestId);
    this.context.watch(t);
    // The question travels with its answer so the decision can be audited.
    this.context.emit(
      t,
      "approval.resolved",
      {
        requestId: p.requestId,
        method: p.method,
        detail: p.detail,
        result,
        reason,
      },
      typeof p.detail?.turnId === "string" ? p.detail.turnId : undefined,
      typeof p.detail?.itemId === "string" ? p.detail.itemId : undefined,
    );
  }
}
