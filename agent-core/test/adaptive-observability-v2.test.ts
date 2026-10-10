import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveObservabilityV2 } from "../src/adaptive-observability-v2";

test("complete provider usage totals and measured projection savings", () => {
  const o = new AdaptiveObservabilityV2();
  o.recordProvider({ status: 200, inputTokens: 100, outputTokens: 10 });
  o.recordProvider({ status: 200, inputTokens: 120, outputTokens: 20 });
  o.recordRouting({ routingMode: "direct_tools" });
  o.recordRouting({ routingMode: "discovery" });
  o.recordModelTool("discover_tools");
  o.recordModelTool("get_apps");
  o.recordProjection({
    serverId: "qlik",
    toolName: "get_apps",
    beforeBytes: 22444,
    afterBytes: 6278,
  });
  const s = o.summary();
  assert.equal(s.providerModelCallCount, 2);
  assert.equal(s.totalTokens, 250);
  assert.equal(s.modelDiscoveryCalls, 1);
  assert.equal(s.fallbackRate, 0.5);
  assert.ok(Math.abs(s.projection.reductionPercent! - 72.028) < 0.01);
  assert.equal(s.cacheReadInputTokens, null);
});
test("failed provider calls with unavailable usage are not zero-token calls", () => {
  const o = new AdaptiveObservabilityV2();
  o.recordProvider({ status: 200, inputTokens: 100, outputTokens: 10 });
  o.recordProvider({ status: 503 });
  const s = o.summary();
  assert.equal(s.inputTokens, null);
  assert.equal(s.totalTokens, null);
  assert.equal(s.knownInputTokens, 100);
  assert.equal(s.callsWithUsage, 1);
  assert.equal(s.providerModelCallCount, 2);
  assert.equal(s.successfulProviderCalls, 1);
});
test("projection byte metrics reject invalid values", () => {
  const o = new AdaptiveObservabilityV2();
  assert.throws(() =>
    o.recordProjection({
      serverId: "q",
      toolName: "get",
      beforeBytes: -1,
      afterBytes: 10,
    }),
  );
  assert.equal(o.summary().fallbackRate, null);
  assert.equal(o.summary().projection.reductionPercent, null);
});
test("reported zero output for an emitted tool call is visible as a usage anomaly", () => {
  const o = new AdaptiveObservabilityV2();
  o.recordProvider({
    status: 200,
    inputTokens: 100,
    outputTokens: 0,
    firstToolTokenMs: 50,
  });
  assert.equal(o.summary().usageSource, "provider_reported");
  assert.equal(o.summary().toolOnlyZeroOutputUsageCalls, 1);
  assert.equal(o.summary().outputTokens, 0);
});
