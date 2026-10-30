import { OFFICE_LIMITS, PreviewError } from "./limits.ts";
import type {
  OfficeKind,
  PreviewRequest,
  PreviewResponse,
  PreviewResult,
} from "./run.ts";

// Runs one preview in its own worker. The worker is stopped as soon as it
// answers, times out, fails to start or the caller aborts, so a file that is
// no longer shown never keeps parsing.

export type PreviewWorker = {
  postMessage(message: PreviewRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<PreviewResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

const startWorker = (): PreviewWorker =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

export function parseInWorker(
  kind: OfficeKind,
  // Transferred to the worker: unusable here afterwards.
  bytes: ArrayBuffer,
  {
    timeoutMs = OFFICE_LIMITS.timeoutMs,
    signal,
    createWorker = startWorker,
  }: {
    timeoutMs?: number;
    signal?: AbortSignal;
    createWorker?: () => PreviewWorker;
  } = {},
): Promise<PreviewResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = createWorker();
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new PreviewError("too-large", "The file took too long to preview."),
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = ({ data }) =>
      finish(() =>
        data.ok
          ? resolve(data.result)
          : reject(new PreviewError(data.code, data.message)),
      );
    worker.onerror = () =>
      finish(() =>
        reject(new PreviewError("unsupported", "The preview couldn't start.")),
      );
    worker.postMessage({ kind, bytes }, [bytes]);
  });
}
