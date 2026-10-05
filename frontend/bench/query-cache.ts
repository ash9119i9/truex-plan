// Repeatable helper experiment, not an application/load benchmark:
// node --experimental-strip-types bench/query-cache.ts
// Identical 20 bursts of three MCP consumers, with simulated 2ms identity
// and 8ms metadata origins. Warm hits still verify /me on every burst.
import { performance } from "node:perf_hooks";
import { api, clearApiCache } from "../lib/api.ts";

const originalFetch = globalThis.fetch;
const originalFlag = process.env.NEXT_PUBLIC_CLIENT_CACHE;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { addEventListener() {} },
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let identity = 0,
  metadata = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/me")) {
    identity++;
    await delay(2);
    return Response.json({
      user: { id: "fixture-user" },
      tenant: { id: "fixture-tenant" },
      role: "user",
    });
  }
  metadata++;
  await delay(8);
  return Response.json({
    profiles: Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      name: "fixture",
      enabled: true,
    })),
    profileIds: ["0"],
  });
};
try {
  const results = [];
  for (const mode of ["off", "cold", "warm"] as const) {
    process.env.NEXT_PUBLIC_CLIENT_CACHE = mode === "off" ? "off" : "on";
    clearApiCache(false);
    identity = 0;
    metadata = 0;
    const latencies = [];
    const started = performance.now();
    for (let burst = 0; burst < 20; burst++) {
      if (mode === "cold") clearApiCache(false);
      const at = performance.now();
      await Promise.all(
        Array.from({ length: 3 }, () => api("/api/agents/fixture/mcp")),
      );
      latencies.push(performance.now() - at);
    }
    latencies.sort((a, b) => a - b);
    results.push({
      mode,
      consumerReads: 60,
      metadataOriginCalls: metadata,
      identityOriginCalls: identity,
      totalMs: Math.round(performance.now() - started),
      p95BurstMs: Number(
        latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(2),
      ),
    });
  }
  console.log(
    JSON.stringify(
      { workload: "simulated helper fixture; not production latency", results },
      null,
      2,
    ),
  );
} finally {
  clearApiCache(false);
  globalThis.fetch = originalFetch;
  if (originalFlag === undefined) delete process.env.NEXT_PUBLIC_CLIENT_CACHE;
  else process.env.NEXT_PUBLIC_CLIENT_CACHE = originalFlag;
  delete (globalThis as any).window;
}
