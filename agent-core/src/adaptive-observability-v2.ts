/** Provider counters are authoritative; missing usage is unknown, never zero. */
export type ProviderObservationV2 = {
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  firstTextTokenMs?: number;
  firstToolTokenMs?: number;
  durationMs?: number;
};
export type ProjectionObservationV2 = {
  serverId: string;
  toolName: string;
  beforeBytes: number;
  afterBytes: number;
  executionLatencyMs?: number;
};
const sumKnown = (
  observations: ProviderObservationV2[],
  key: keyof ProviderObservationV2,
) =>
  observations.every((o) => typeof o[key] === "number")
    ? observations.reduce((n, o) => n + Number(o[key]), 0)
    : null;

export class AdaptiveObservabilityV2 {
  readonly providerCalls: ProviderObservationV2[] = [];
  readonly projections: ProjectionObservationV2[] = [];
  readonly routes: Record<string, any>[] = [];
  private discoveryCalls = 0;
  recordProvider(call: ProviderObservationV2) {
    this.providerCalls.push({ ...call });
  }
  recordRouting(trace: Record<string, any>) {
    this.routes.push(structuredClone(trace));
  }
  recordProjection(trace: ProjectionObservationV2) {
    if (
      !Number.isSafeInteger(trace.beforeBytes) ||
      !Number.isSafeInteger(trace.afterBytes) ||
      trace.beforeBytes < 0 ||
      trace.afterBytes < 0
    )
      throw new Error("Invalid projection measurements");
    this.projections.push({ ...trace });
  }
  recordModelTool(name: string) {
    if (["discover_server", "discover_tools", "get_tool_schema"].includes(name))
      this.discoveryCalls++;
  }
  summary() {
    const calls = this.providerCalls;
    const inputTokens = sumKnown(calls, "inputTokens"),
      outputTokens = sumKnown(calls, "outputTokens");
    const beforeBytes = this.projections.reduce((n, p) => n + p.beforeBytes, 0);
    const afterBytes = this.projections.reduce((n, p) => n + p.afterBytes, 0);
    return {
      providerModelCallCount: calls.length,
      usageSource: "provider_reported",
      toolOnlyZeroOutputUsageCalls: calls.filter(
        (c) => c.outputTokens === 0 && c.firstToolTokenMs !== undefined,
      ).length,
      successfulProviderCalls: calls.filter(
        (c) => c.status !== undefined && c.status >= 200 && c.status < 300,
      ).length,
      callsWithUsage: calls.filter(
        (c) =>
          typeof c.inputTokens === "number" &&
          typeof c.outputTokens === "number",
      ).length,
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens === null || outputTokens === null
          ? null
          : inputTokens + outputTokens,
      knownInputTokens: calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0),
      knownOutputTokens: calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
      cacheReadInputTokens: sumKnown(calls, "cacheReadInputTokens"),
      cacheCreationInputTokens: sumKnown(calls, "cacheCreationInputTokens"),
      modelDiscoveryCalls: this.discoveryCalls,
      routingDecisions: this.routes.length,
      fallbackRate: this.routes.length
        ? this.routes.filter(
            (r) => r.routingMode === "discovery" || r.mode === "discovery",
          ).length / this.routes.length
        : null,
      projection: {
        beforeBytes,
        afterBytes,
        reductionPercent: beforeBytes
          ? (1 - afterBytes / beforeBytes) * 100
          : null,
      },
      firstTextTokenMs: calls.map((c) => c.firstTextTokenMs ?? null),
      firstToolTokenMs: calls.map((c) => c.firstToolTokenMs ?? null),
      providerCallLatencyMs: calls.map((c) => c.durationMs ?? null),
    };
  }
}
