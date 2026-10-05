// Default is a dry run. --live explicitly makes two sequential, billable gateway calls.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const input = {
  instructions:
    "Use only fictional inventory records in this synthetic benchmark. ".repeat(
      700,
    ),
  input: [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Reply with the single word READY. Do not call tools.",
        },
      ],
    },
  ],
  prompt_cache_key: "truex-offline-probe-v1",
  tools: [],
};
const body = JSON.stringify(input);

async function main() {
  if (!process.argv.includes("--live")) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          networkCalls: 0,
          requestBytes: Buffer.byteLength(body),
          requestHash: createHash("sha256").update(body).digest("hex"),
          instructions:
            "Use --live with PROBE_GATEWAY_URL, PROBE_PROFILE_ID and PROBE_GATEWAY_TOKEN for two billable synthetic requests. Verify endpoint/model threshold, retention and test budget first.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const url = process.env.PROBE_GATEWAY_URL,
    profile = process.env.PROBE_PROFILE_ID,
    token = process.env.PROBE_GATEWAY_TOKEN;
  if (!url || !profile || !token) throw new Error("missing configuration");
  const endpoint = new URL(
    `/p/${encodeURIComponent(profile)}/v1/responses`,
    url,
  );
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("invalid endpoint");
  const results: unknown[] = [];
  for (let index = 0; index < 2; index++) {
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error("gateway request failed");
    const headersMs = performance.now() - started;
    let completed: any;
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.failed")
        throw new Error("gateway stream failed");
      if (event.type === "response.completed") completed = event.response;
    }
    if (!completed?.usage) throw new Error("missing usage");
    const usage = completed.usage;
    results.push({
      request: index + 1,
      headersMs: +headersMs.toFixed(1),
      durationMs: +(performance.now() - started).toFixed(1),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? null,
    });
  }
  console.log(
    JSON.stringify(
      {
        mode: "live",
        networkCalls: 2,
        results,
        note: "Headers latency is not necessarily TTFT. A zero hit can indicate model thresholds, expiry, unstable upstream rendering or unsupported proxy behavior; examine normalized gateway logs.",
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error(
    "Provider cache probe failed; configuration, endpoint and response bodies were not printed.",
  );
  process.exitCode = 1;
});
