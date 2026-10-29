import assert from "node:assert/strict";
import { type Harness, readSse, type SseEvent } from "./harness";
import { sleep } from "./model-fixture";

// Shared by the goal tests (tasks/goal-mode-todo.md): the fixture model's
// goal moves and a reader for the chat stream.

type Body = Record<string, unknown>;

export const GOALS = { maxTokenBudget: 200_000 };
export const OBJECTIVE = "GOAL_OBJECTIVE: write the quarterly summary.";
export const CONTINUATION = "Continue working toward the active thread goal.";
// The model marks the goal complete; Codex then asks it once more.
export const COMPLETE = {
  kind: "call",
  name: "update_goal",
  args: { status: "complete" },
} as const;

export const reply = (text: string) => ({ kind: "reply", text }) as const;

export const isContinuation = (body: Body) =>
  JSON.stringify(body.input ?? []).includes(CONTINUATION);

// A run's body without its own ID, input and goals: what an active set
// carries to start or resume the thread.
export function context(body: Body): Body {
  const {
    runId: _run,
    tenantId: _tenant,
    chatId: _chat,
    input: _input,
    goals: _goals,
    ...run
  } = body;
  return run;
}

export async function until(
  check: () => boolean | Promise<boolean>,
  ms = 20_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(50);
  }
  return check();
}

export interface ChatStream {
  readonly events: SseEvent[];
  close(): Promise<void>;
}

// Holds GET /v1/chats/:chatId/events open, collecting its events, until
// `close`. The stream never ends by itself.
export async function openChatStream(
  h: Harness,
  chatId: string,
  options: { after?: number; streamId?: string; tenantId?: string } = {},
): Promise<ChatStream> {
  const controller = new AbortController();
  const query = new URLSearchParams({
    tenantId: options.tenantId ?? "tenant1",
    after: String(options.after ?? 0),
    ...(options.streamId !== undefined && { streamId: options.streamId }),
  });
  const res = await h.fetch(`/v1/chats/${chatId}/events?${query}`, {
    signal: controller.signal,
  });
  // Read the body only on failure: a 200 stream never ends.
  if (res.status !== 200)
    assert.fail(`chat stream: ${res.status} ${await res.text()}`);
  const events: SseEvent[] = [];
  const reading = readSse(res, (event) => {
    events.push(event);
  }).catch(() => undefined);
  return {
    events,
    close: async () => {
      controller.abort();
      await reading;
    },
  };
}

export const ofType = (events: SseEvent[], type: string) =>
  events.filter((event) => event.type === type);
