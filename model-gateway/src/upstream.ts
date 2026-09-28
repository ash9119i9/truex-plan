// Time limits on the provider call. Without them a provider that accepts the
// connection but never answers (or stalls mid-stream) holds the request until
// Codex's own 300s stream idle timeout. Failing fast lets Codex retry sooner.
export class UpstreamTimeoutError extends Error {
  override name = "UpstreamTimeoutError";
}

export interface UpstreamTimeouts {
  /**
   * Max wait from sending the request to the first body byte. 0 disables.
   * Headers alone don't count: NVIDIA's hosted API was measured returning
   * headers in ~0.3s and then sending nothing for up to 108s while queued.
   */
  firstByteMs: number;
  /** Max gap between body chunks after the first one. 0 disables. */
  idleMs: number;
}

export function withTimeouts(
  base: typeof fetch,
  limits: UpstreamTimeouts,
): typeof fetch {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const outer = init.signal;
    const onAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, what: string) => {
      clearTimeout(timer);
      if (ms > 0)
        timer = setTimeout(
          () =>
            controller.abort(
              new UpstreamTimeoutError(
                `no ${what} from the model provider within ${ms}ms`,
              ),
            ),
          ms,
        );
    };
    const done = () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };
    const reason = (error: unknown) =>
      controller.signal.reason instanceof UpstreamTimeoutError
        ? controller.signal.reason
        : error;

    arm(limits.firstByteMs, "response");
    let res: Response;
    try {
      res = await base(input, { ...init, signal: controller.signal });
    } catch (error) {
      done();
      throw reason(error);
    }
    if (!res.body) {
      done();
      return res;
    }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done: end, value } = await reader.read();
          if (end) {
            done();
            stream.close();
            return;
          }
          arm(limits.idleMs, "data");
          stream.enqueue(value);
        } catch (error) {
          done();
          stream.error(reason(error));
        }
      },
      cancel(why) {
        done();
        return reader.cancel(why);
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
