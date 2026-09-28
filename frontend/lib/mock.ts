import type { Transport } from "./transport";
import type { DomainEvent, TurnTrace } from "../../shared/contracts";

// A realistic trace so the observability UI can be seen without a backend.
export function mockTrace(turnId = "turn", startedAt = new Date()): TurnTrace {
  const step = (
    id: string,
    kind: TurnTrace["steps"][number]["kind"],
    label: string,
    startMs: number,
    durationMs: number,
    agent = "main",
  ) => ({
    id,
    kind,
    label,
    agent,
    agentThreadId: agent === "main" ? "mock" : `mock-${agent}`,
    startMs,
    durationMs,
    status: "completed" as const,
  });
  return {
    turnId,
    threadId: "mock",
    startedAt: startedAt.toISOString(),
    totalMs: 4_200,
    status: "completed",
    model: "mock-model",
    steps: [
      step("s1", "thinking", "Thinking", 0, 650),
      step("s2", "command", "Ran a command", 650, 1_900),
      step("s3", "tool", "Read 3 files", 900, 1_200, "researcher"),
      step("s4", "message", "Writing the reply", 2_600, 1_550),
    ],
    usage: {
      inputTokens: 9_800,
      cachedInputTokens: 6_400,
      outputTokens: 1_300,
      reasoningOutputTokens: 420,
      totalTokens: 11_100,
      contextWindow: 200_000,
      contextUsedTokens: 76_000,
    },
    helperUsage: {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 200,
      reasoningOutputTokens: 0,
      totalTokens: 1_200,
    },
    rateLimits: {
      limitName: null,
      primaryUsedPercent: 34,
      primaryWindowMins: 300,
      primaryResetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
      secondaryUsedPercent: 12,
      secondaryWindowMins: 10_080,
      secondaryResetsAt: Math.floor(Date.now() / 1000) + 3 * 86_400,
      reached: null,
      at: new Date().toISOString(),
    },
    privacy: {
      scannedChars: 5_120,
      findings: [
        { kind: "email", source: "toolOutput", count: 1, sample: "j***@***.com" },
      ],
    },
  };
}
export function mockTransport(): Transport {
  let listener = (e: DomainEvent) => {},
    seq = 0,
    resolve: () => void = () => {},
    stopped = false;
  const emit = (type: DomainEvent["type"], data: any) =>
    listener({
      type,
      data,
      seq: ++seq,
      cursor: `mock:${seq}`,
      at: new Date().toISOString(),
      threadId: "mock",
      turnId: "turn",
      itemId: "answer",
    });
  return {
    subscribe: (_id, fn, status) => {
      listener = fn;
      status("Mock");
      return () => {
        listener = () => {};
      };
    },
    async send() {
      stopped = false;
      emit("turn.started", {});
      void (async () => {
        emit("reasoning.delta", { delta: "Thinking through your request…" });
        const requestId = "mock-approval";
        emit("approval.requested", {
          requestId,
          method: "item/commandExecution/requestApproval",
          detail: { command: "Read the project files" },
          expiresAt: new Date(Date.now() + 15000).toISOString(),
        });
        await new Promise<void>((r) => {
          const timer = setTimeout(() => {
            emit("approval.resolved", { requestId, reason: "expired" });
            r();
          }, 15000);
          resolve = () => {
            clearTimeout(timer);
            emit("approval.resolved", { requestId, reason: "user" });
            r();
          };
        });
        let text = "";
        for (const word of "This response exercises the same streaming contract as the runtime.".split(
          " ",
        )) {
          if (stopped) break;
          await new Promise((r) => setTimeout(r, 100));
          text += word + " ";
          emit("message.delta", { delta: word + " " });
        }
        emit("message.final", { text });
        emit("usage.updated", { usage: mockTrace().usage });
        emit("turn.completed", { trace: mockTrace() });
      })();
      return { turnId: "turn", steer: false };
    },
    async interrupt() {
      stopped = true;
      resolve();
      return { ok: true };
    },
    async answer() {
      resolve();
      return { ok: true };
    },
  };
}
