// Offline only: measures local cache behavior against a controlled 2ms authority.
import { performance } from "node:perf_hooks";
import { createProfileStore, type ProfileStore } from "../src/profiles";

const requests = 400,
  concurrency = 16,
  profiles = 8;
let queries = 0,
  unavailable = false,
  offset = 0;
const collection = {
  async findOne(filter: any) {
    queries++;
    await new Promise((r) => setTimeout(r, 2));
    if (unavailable) throw new Error("synthetic authority unavailable");
    return {
      _id: filter._id.$in[0],
      baseUrl: "https://fictional.invalid",
      modelName: "synthetic",
      wireApi: "chat",
      apiKey: "synthetic-only",
    };
  },
};
const percentile = (times: number[], p: number) =>
  times[Math.min(times.length - 1, Math.floor(times.length * p))];

async function measure(mode: string, store: ProfileStore) {
  const before = queries,
    times: number[] = [];
  let cursor = 0,
    errors = 0;
  const began = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < requests) {
        const request = cursor++,
          at = performance.now();
        try {
          await store.find(`profile-${request % profiles}`);
        } catch {
          errors++;
        }
        times.push(performance.now() - at);
      }
    }),
  );
  times.sort((a, b) => a - b);
  return {
    mode,
    requests,
    concurrency,
    authorityCalls: queries - before,
    errors,
    elapsedMs: +(performance.now() - began).toFixed(3),
    p50Ms: +percentile(times, 0.5).toFixed(3),
    p95Ms: +percentile(times, 0.95).toFixed(3),
    p99Ms: +percentile(times, 0.99).toFixed(3),
    cache: store.stats(),
  };
}

async function main() {
  const common = { collection, now: () => Date.now() + offset };
  const disabled = createProfileStore({ ...common, ttlMs: 0 });
  const cached = createProfileStore({ ...common, ttlMs: 30000 });
  const results = [
    await measure("disabled (single-flight retained)", disabled),
    await measure("cold", cached),
    await measure("warm", cached),
  ];
  unavailable = true;
  offset = 30001;
  results.push(
    await measure(
      "expired cache + authority outage (must fail closed)",
      cached,
    ),
  );
  console.log(
    JSON.stringify(
      {
        benchmark: "gateway-profile-cache",
        authority: "synthetic 2ms delay; no network/provider/Mongo calls",
        results,
        improvement: {
          warmP95Percent: +(
            100 *
            (1 - results[2].p95Ms / results[0].p95Ms)
          ).toFixed(1),
          coldOriginReductionPercent: +(
            100 *
            (1 - results[1].authorityCalls / results[0].authorityCalls)
          ).toFixed(1),
        },
      },
      null,
      2,
    ),
  );
}
main().catch(() => {
  console.error("Offline cache benchmark failed.");
  process.exitCode = 1;
});
