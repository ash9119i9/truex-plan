import type { Transport } from "./transport";
import type { DomainEvent } from "../../shared/contracts";
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
        emit("turn.completed", {});
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
