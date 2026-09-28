import type { ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Usage } from "./responses";

// Facts recorded where a response is written (ResponsesStream, sendError), so
// the server logs one line per request without adapters reporting anything.
interface Recorded {
  firstByteAt?: number;
  outcome?: string;
  errorCode?: string;
  usage?: Usage;
}

const recorded = new WeakMap<ServerResponse, Recorded>();

export function record(res: ServerResponse, facts: Recorded) {
  const current = recorded.get(res) ?? {};
  recorded.set(res, {
    ...current,
    ...facts,
    firstByteAt: current.firstByteAt ?? facts.firstByteAt,
  });
}

export interface RequestMeta {
  requestId: string;
  profileId?: string;
  wireApi?: string;
  model?: string;
}

// One JSON line per model request. Never includes bodies, prompts, tokens or
// provider keys: only ids, timings, status and token counts.
export function accessLogLine(
  meta: RequestMeta,
  res: ServerResponse,
  startedAt: number,
) {
  const r = recorded.get(res) ?? {};
  return JSON.stringify({
    ts: new Date().toISOString(),
    type: "access",
    requestId: meta.requestId,
    profileId: meta.profileId,
    wireApi: meta.wireApi,
    model: meta.model,
    status: res.statusCode,
    // A response that never finished was cut off: Codex disconnected or the
    // connection was force-closed on shutdown.
    outcome: r.outcome ?? (res.writableFinished ? "unknown" : "client_closed"),
    errorCode: r.errorCode,
    durationMs: Math.round(performance.now() - startedAt),
    ttfbMs:
      r.firstByteAt === undefined
        ? undefined
        : Math.round(r.firstByteAt - startedAt),
    usage: r.usage && {
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      total_tokens: r.usage.total_tokens,
    },
  });
}
