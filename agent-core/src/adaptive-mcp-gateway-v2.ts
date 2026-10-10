import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  omniTools,
  projectFields,
  type ConnectorConfig,
  type GatewayEvent,
} from "./omni-mcp-gateway";
import {
  McpTransportV2,
  DownstreamRpcErrorV2,
  McpTransportErrorV2,
  type TransportToolV2,
} from "./mcp-transport-v2";
import { Redactor } from "./redact";
import {
  createExposedBindings,
  type RegisteredTool,
  type RoutePlan,
} from "./tool-router-v2";

export interface AdaptiveGatewayScope {
  tenantId: string;
  userId: string;
}
export interface AdaptiveMcpGatewayV2Options {
  scope: AdaptiveGatewayScope;
  authorizeExposure?: (
    tool: RegisteredTool,
    scope: Readonly<AdaptiveGatewayScope>,
  ) => boolean | Promise<boolean>;
  authorizeExecution?: (
    tool: RegisteredTool,
    args: Record<string, unknown>,
    scope: Readonly<AdaptiveGatewayScope>,
  ) => boolean | Promise<boolean>;
  reservedNames?: string[];
  maxCallsPerMinute?: number;
  maxConcurrentCalls?: number;
  receiptTtlMs?: number;
  hydration?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    hydrationTimeoutMs?: number;
  };
}
export interface ConnectorStatusV2 {
  server: string;
  state: "initializing" | "ready" | "empty" | "unavailable" | "disabled";
  upstreamToolCount: number;
  attempts: number;
  updatedAt: string;
  lastError?: {
    message: string;
    kind: string;
    stage: string;
    retryable: boolean;
  };
}
export interface RegistryStatusV2 {
  state: "initializing" | "ready" | "degraded" | "failed";
  configuredServerCount: number;
  enabledServerCount: number;
  upstreamToolCount: number;
  registryVersion: number;
  servers: ConnectorStatusV2[];
}
export type GatewayInvalidationReasonV2 =
  "reconnect" | "schema" | "config" | "permission" | "enable";
type Binding = {
  registered: RegisteredTool;
  upstream: TransportToolV2;
  projectionProperty: string;
  validate: ValidateFunction;
  validateUpstream: ValidateFunction;
};
type Receipt = { key: string; generation: number; expiresAt: number };
const MAX_BYTES = 8 * 1024 * 1024;
const isObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const copy = <T>(value: T): T => structuredClone(value);
const keyFor = (server: string, tool: string) => JSON.stringify([server, tool]);
const stable = (value: any): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
function validFields(fields: unknown): fields is string[] {
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    fields.some((field) => typeof field !== "string")
  )
    return false;
  if (fields.length === 1 && fields[0] === "*") return true;
  projectFields({}, fields);
  return true;
}
function parseResult(result: any) {
  if (
    result?.structuredContent !== undefined &&
    result?.structuredContent !== null
  )
    return result.structuredContent;
  if (
    Array.isArray(result?.content) &&
    result.content.length === 1 &&
    result.content[0]?.type === "text"
  ) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      /* Explicit full-result escape is needed for text. */
    }
  }
  throw new Error(
    "Downstream action completed, but its response is not projectable JSON. Do not repeat the action automatically.",
  );
}
function hasPath(value: any, parts: string[]): boolean {
  return (
    !parts.length ||
    (Array.isArray(value)
      ? !value.length || value.some((item) => hasPath(item, parts))
      : isObject(value) &&
        Object.hasOwn(value, parts[0]) &&
        hasPath(value[parts[0]], parts.slice(1)))
  );
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) frozen(part);
    Object.freeze(value);
  }
  return value;
}

/** Opt-in adaptive gateway; native tool dispatch remains with BusinessRuntime. */
export class AdaptiveMcpGatewayV2 {
  readonly scope: Readonly<AdaptiveGatewayScope>;
  private configs: Record<string, ConnectorConfig>;
  private readonly stopped = new AbortController();
  private readonly redactor = new Redactor();
  private readonly authToken = randomBytes(32).toString("hex");
  private readonly connectors = new Map<string, McpTransportV2>();
  private readonly bindings = new Map<string, Binding>();
  private readonly byId = new Map<string, Binding>();
  private readonly unavailable = new Map<string, string>();
  private readonly connectorStatuses = new Map<string, ConnectorStatusV2>();
  private readonly metadataCache = new Map<string, TransportToolV2[]>();
  private hydrating = false;
  private readonly ajv = new Ajv({
    strict: false,
    validateFormats: false,
    allErrors: true,
  });
  private readonly ajv2020 = new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: true,
  });

  /** Honor the upstream dialect while retaining draft-07 for existing tools. */
  private compileToolSchema(schema: Record<string, any>): ValidateFunction {
    const validator =
      /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(
        schema.$schema || "",
      )
        ? this.ajv2020
        : this.ajv;
    return validator.compile(schema);
  }
  private readonly fallbackDefinitions: TransportToolV2[];
  private readonly fallbackChecks = new Map<string, ValidateFunction>();
  private hydration?: Promise<RegisteredTool[]>;
  private registryVersion = 0;
  private generation = 0;
  private routing?: {
    mode: RoutePlan["mode"];
    selected: Set<string>;
    query: string;
    registryVersion: number;
  };
  private readonly platformProjections = new Map<string, string[]>();
  private readonly receipts: Receipt[] = [];
  private readonly callTimes: number[] = [];
  private activeCalls = 0;
  private readonly requests = new Map<string, AbortController>();
  private server?: Server;
  private endpoint?: string;
  private starting?: Promise<void>;
  private servedCatalogFingerprint?: string;
  constructor(
    configs: Record<string, ConnectorConfig>,
    readonly onEvent?: (event: GatewayEvent) => void,
    private readonly fetcher: typeof fetch = fetch,
    private readonly options: AdaptiveMcpGatewayV2Options = {
      scope: { tenantId: "default", userId: "platform" },
    },
  ) {
    if (!options.scope?.tenantId || !options.scope?.userId)
      throw new Error("An immutable tenant and user scope is required");
    this.scope = frozen(copy(options.scope));
    for (const [key, value] of Object.entries({
      maxCallsPerMinute: options.maxCallsPerMinute,
      maxConcurrentCalls: options.maxConcurrentCalls,
      receiptTtlMs: options.receiptTtlMs,
      maxAttempts: options.hydration?.maxAttempts,
      hydrationTimeoutMs: options.hydration?.hydrationTimeoutMs,
    })) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1))
        throw new Error(`Invalid ${key}`);
    }
    if (
      options.hydration?.retryDelayMs !== undefined &&
      (!Number.isInteger(options.hydration.retryDelayMs) ||
        options.hydration.retryDelayMs < 0)
    )
      throw new Error("Invalid retryDelayMs");
    if ((options.hydration?.maxAttempts || 2) > 5)
      throw new Error("Metadata retry attempts must be at most five");
    this.configs = copy(configs);
    this.replaceConnectors();
    this.fallbackDefinitions = copy(omniTools);
    const discover = this.fallbackDefinitions.find(
      (tool) => tool.name === "discover_tools",
    )!;
    discover.inputSchema.properties.cursor = {
      type: "string",
      description: "Next cursor from a previous discovery page.",
    };
    discover.inputSchema.properties.limit = {
      type: "integer",
      minimum: 1,
      maximum: 1000,
    };
    const invoke = this.fallbackDefinitions.find(
      (tool) => tool.name === "invoke_tool",
    )!;
    invoke.inputSchema.required.push("fields");
    invoke.description =
      "Invoke an attached authorized tool after discovery. fields is required: choose answer fields and identifiers/pagination, or ['*'] alone for intentional full output. Execution and approval are independently checked.";
    for (const tool of this.fallbackDefinitions)
      this.fallbackChecks.set(tool.name, this.ajv.compile(tool.inputSchema));
  }
  get exposedNames(): ReadonlyMap<string, RegisteredTool> {
    return new Map(
      [...this.bindings].map(([name, binding]) => {
        const registered = copy(binding.registered);
        if (this.platformProjections.has(registered.id)) {
          const properties = registered.inputSchema.properties as Record<
            string,
            unknown
          >;
          delete properties[binding.projectionProperty];
          if (Array.isArray(registered.inputSchema.required))
            registered.inputSchema.required =
              registered.inputSchema.required.filter(
                (property) => property !== binding.projectionProperty,
              );
        }
        return [name, registered];
      }),
    );
  }
  get fallbackTools(): readonly TransportToolV2[] {
    return copy(this.fallbackDefinitions);
  }
  get projectionProperties(): ReadonlyMap<string, string> {
    return new Map(
      [...this.bindings].map(([name, binding]) => [
        name,
        binding.projectionProperty,
      ]),
    );
  }
  get unavailableServers(): ReadonlyMap<string, string> {
    return new Map(this.unavailable);
  }
  get hasUnavailable(): boolean {
    return this.unavailable.size > 0;
  }
  get registryStatus(): Readonly<RegistryStatusV2> {
    const servers = [...this.connectorStatuses.values()].map(copy);
    const enabled = servers.filter((server) => server.state !== "disabled");
    const ready = enabled.filter((server) => server.state === "ready").length;
    const state = this.stopped.signal.aborted
      ? "failed"
      : this.hydrating ||
          enabled.some((server) => server.state === "initializing")
        ? "initializing"
        : !enabled.length || ready === enabled.length
          ? "ready"
          : ready
            ? "degraded"
            : "failed";
    return frozen({
      state,
      configuredServerCount: servers.length,
      enabledServerCount: enabled.length,
      upstreamToolCount: enabled.reduce(
        (sum, server) => sum + server.upstreamToolCount,
        0,
      ),
      registryVersion: this.registryVersion,
      servers,
    });
  }
  private event(type: string, data: Record<string, unknown>) {
    try {
      this.onEvent?.({
        type,
        at: new Date().toISOString(),
        scope: this.scope,
        ...this.redactor.clean(data),
      });
    } catch {
      /* Audit failures cannot repeat a remote action. */
    }
  }
  private cleanMetadata(value: any): any {
    if (typeof value === "string") return this.redactor.clean(value);
    if (Array.isArray(value))
      return value.map((part) => this.cleanMetadata(part));
    if (isObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, part]) => [
          key,
          this.cleanMetadata(part),
        ]),
      );
    return value;
  }
  private replaceConnectors() {
    this.connectors.clear();
    this.connectorStatuses.clear();
    this.metadataCache.clear();
    for (const [server, config] of Object.entries(this.configs)) {
      this.connectorStatuses.set(server, {
        server,
        state: config.enabled === false ? "disabled" : "initializing",
        upstreamToolCount: 0,
        attempts: 0,
        updatedAt: new Date().toISOString(),
      });
      if (config.enabled === false) continue;
      const url = new URL(config.url);
      if (
        !server ||
        config.command ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("Adaptive connectors must use approved HTTP URLs");
      this.redactor.remember(config);
      this.connectors.set(
        server,
        new McpTransportV2(config, this.stopped.signal, this.fetcher, (event) =>
          this.event(event.type, { ...event, server }),
        ),
      );
    }
  }
  private async allowed(
    tool: RegisteredTool,
    execution = false,
    args: Record<string, unknown> = {},
  ) {
    const config = this.configs[tool.serverId];
    if (
      !config ||
      this.unavailable.has(tool.serverId) ||
      config.enabled === false ||
      (config.enabled_tools && !config.enabled_tools.includes(tool.toolName)) ||
      config.disabled_tools?.includes(tool.toolName) ||
      tool.enabled === false ||
      tool.available === false ||
      tool.tenantId !== this.scope.tenantId
    )
      return false;
    try {
      if (
        this.options.authorizeExposure &&
        !(await this.options.authorizeExposure(copy(tool), this.scope))
      )
        return false;
      return (
        !execution ||
        !this.options.authorizeExecution ||
        !!(await this.options.authorizeExecution(
          copy(tool),
          copy(args),
          this.scope,
        ))
      );
    } catch {
      return false;
    }
  }
  private async hydrateConnector(
    server: string,
    connector: McpTransportV2,
    version: number,
    overrides: { maxAttempts?: number; retryDelayMs?: number } = {},
  ) {
    const maxAttempts =
      overrides.maxAttempts ?? this.options.hydration?.maxAttempts ?? 2;
    const retryDelayMs =
      overrides.retryDelayMs ?? this.options.hydration?.retryDelayMs ?? 100;
    const hydrationTimeoutMs = Math.min(
      this.options.hydration?.hydrationTimeoutMs ?? 30000,
      Math.ceil((this.configs[server].startup_timeout_sec || 30) * 1000),
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (version !== this.registryVersion)
        throw new Error("Registry invalidated during hydration");
      this.stopped.signal.throwIfAborted();
      this.connectorStatuses.set(server, {
        server,
        state: "initializing",
        upstreamToolCount: 0,
        attempts: attempt,
        updatedAt: new Date().toISOString(),
      });
      const attemptStarted = performance.now(),
        attemptStartedAt = new Date().toISOString();
      this.event("hydration_attempt", {
        phase: "started",
        server,
        attempt,
        maxAttempts,
        hydrationTimeoutMs,
        startedAt: attemptStartedAt,
      });
      try {
        const tools = await connector.tools(
          AbortSignal.any([
            this.stopped.signal,
            AbortSignal.timeout(hydrationTimeoutMs),
          ]),
        );
        if (version !== this.registryVersion)
          throw new Error("Registry invalidated during hydration");
        this.metadataCache.set(server, copy(tools));
        this.unavailable.delete(server);
        this.connectorStatuses.set(server, {
          server,
          state: tools.length ? "ready" : "empty",
          upstreamToolCount: tools.length,
          attempts: attempt,
          updatedAt: new Date().toISOString(),
          ...(!tools.length
            ? {
                lastError: {
                  message: "Attached connector returned no tool schemas",
                  kind: "empty",
                  stage: "tools/list",
                  retryable: false,
                },
              }
            : {}),
        });
        this.event("connector_health", {
          ...this.connectorStatuses.get(server),
          phase: "hydration",
        });
        this.event("hydration_attempt", {
          phase: "completed",
          server,
          attempt,
          maxAttempts,
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: performance.now() - attemptStarted,
          toolCount: tools.length,
        });
        return;
      } catch (error: any) {
        if (version !== this.registryVersion || this.stopped.signal.aborted)
          throw error;
        const detail = {
          message: this.redactor.clean(
            String(error.message || "Connector unavailable"),
          ),
          kind: error instanceof McpTransportErrorV2 ? error.kind : "protocol",
          stage:
            error instanceof McpTransportErrorV2 ? error.stage : "tools/list",
          retryable: error instanceof McpTransportErrorV2 && error.retryable,
        };
        connector.invalidate();
        this.connectorStatuses.set(server, {
          server,
          state: "unavailable",
          upstreamToolCount: 0,
          attempts: attempt,
          updatedAt: new Date().toISOString(),
          lastError: detail,
        });
        this.unavailable.set(server, detail.message);
        this.event("unavailable", {
          server,
          message: detail.message,
          kind: detail.kind,
          stage: detail.stage,
          retryable: detail.retryable,
          phase: "hydration",
          attempt,
        });
        this.event("hydration_attempt", {
          phase: "failed",
          server,
          attempt,
          maxAttempts,
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: performance.now() - attemptStarted,
          errorStage: detail.stage,
          errorKind: detail.kind,
        });
        if (!detail.retryable || attempt === maxAttempts) return;
        this.event("metadata_retry", {
          server,
          attempt: attempt + 1,
          maxAttempts,
          retryDelayMs,
          stage: detail.stage,
        });
        if (retryDelayMs)
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              clearTimeout(timer);
              this.stopped.signal.removeEventListener("abort", abort);
            };
            const abort = () => {
              done();
              reject(this.stopped.signal.reason);
            };
            const timer = setTimeout(() => {
              done();
              resolve();
            }, retryDelayMs);
            this.stopped.signal.addEventListener("abort", abort, {
              once: true,
            });
          });
      }
    }
  }
  async initializeRegistry(
    overrides: { maxAttempts?: number; retryDelayMs?: number } = {},
  ): Promise<RegisteredTool[]> {
    this.stopped.signal.throwIfAborted();
    if (
      overrides.maxAttempts !== undefined &&
      (!Number.isInteger(overrides.maxAttempts) ||
        overrides.maxAttempts < 1 ||
        overrides.maxAttempts > 5)
    )
      throw new Error("Invalid metadata hydration attempts");
    if (
      overrides.retryDelayMs !== undefined &&
      (!Number.isInteger(overrides.retryDelayMs) || overrides.retryDelayMs < 0)
    )
      throw new Error("Invalid metadata hydration delay");
    if (this.hydration) {
      await this.hydration;
      return [...this.bindings.values()].map((binding) =>
        copy(binding.registered),
      );
    }
    const version = this.registryVersion;
    this.hydrating = true;
    const pending = (async () => {
      const started = performance.now();
      await Promise.all(
        [...this.connectors].map(async ([server, connector]) => {
          if (!this.metadataCache.has(server))
            await this.hydrateConnector(server, connector, version, overrides);
        }),
      );
      if (version !== this.registryVersion || this.stopped.signal.aborted)
        throw new Error("Registry invalidated during hydration");
      const entries = [...this.metadataCache]
        .flatMap(([server, tools]) => tools.map((tool) => ({ server, tool })))
        .sort((a, b) =>
          keyFor(a.server, a.tool.name).localeCompare(
            keyFor(b.server, b.tool.name),
          ),
        );
      const normalizationStarted = performance.now();
      const registered = createExposedBindings(
        entries.map(({ server, tool }): RegisteredTool => ({
          id: keyFor(server, tool.name),
          serverId: server,
          serverName: server,
          toolName: tool.name,
          name: tool.name,
          sourceType: "mcp",
          source: "mcp",
          tenantId: this.scope.tenantId,
          scope: "tenant",
          inputSchema: this.cleanMetadata(copy(tool.inputSchema)),
          ...(tool.description
            ? { description: this.cleanMetadata(tool.description) }
            : {}),
          ...(tool.outputSchema
            ? { outputSchema: this.cleanMetadata(tool.outputSchema) }
            : {}),
          ...(tool.annotations
            ? { annotations: this.cleanMetadata(tool.annotations) }
            : {}),
          enabled: true,
          available: !this.unavailable.has(server),
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true,
          requiresApproval: true,
        })),
        [
          ...(this.options.reservedNames || []),
          ...this.fallbackDefinitions.map((tool) => tool.name),
        ],
      );
      const nextBindings = new Map<string, Binding>();
      for (let index = 0; index < registered.length; index++) {
        const descriptor = registered[index],
          tool = entries[index].tool,
          inputSchema = descriptor.inputSchema as Record<string, any>;
        if (
          inputSchema.type !== "object" ||
          !isObject(inputSchema.properties ?? {})
        )
          throw new Error("Adaptive tool arguments must use an object schema");
        inputSchema.properties ??= {};
        let projectionProperty = Object.hasOwn(inputSchema.properties, "fields")
          ? "_gatewayFields"
          : "fields";
        while (Object.hasOwn(inputSchema.properties, projectionProperty))
          projectionProperty = `_${projectionProperty}`;
        inputSchema.properties[projectionProperty] = {
          type: "array",
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: "string" },
          description:
            "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output.",
        };
        if (tool.name !== "get_apps")
          inputSchema.required = [
            ...new Set([...(inputSchema.required || []), projectionProperty]),
          ];
        // Cache metadata, never a caller's current permission decision.
        nextBindings.set(descriptor.bindingName!, {
          registered: frozen(descriptor),
          upstream: frozen(copy(tool)),
          projectionProperty,
          validate: this.compileToolSchema(inputSchema),
          validateUpstream: this.compileToolSchema(tool.inputSchema),
        });
      }
      if (version !== this.registryVersion || this.stopped.signal.aborted)
        throw new Error("Registry invalidated during hydration");
      this.event("registry_normalization", {
        registryVersion: version,
        toolCount: registered.length,
        durationMs: performance.now() - normalizationStarted,
      });
      const commitStarted = performance.now();
      this.bindings.clear();
      this.byId.clear();
      for (const [name, binding] of nextBindings) {
        this.bindings.set(name, binding);
        this.byId.set(binding.registered.id, binding);
      }
      this.event("binding_commit", {
        registryVersion: version,
        toolCount: nextBindings.size,
        durationMs: performance.now() - commitStarted,
      });
      this.hydrating = false;
      let authorizedExposureCount = 0;
      for (const binding of this.bindings.values())
        if (await this.allowed(binding.registered)) authorizedExposureCount++;
      this.event("registry", {
        registryVersion: version,
        tools: nextBindings.size,
        upstreamToolCount: this.registryStatus.upstreamToolCount,
        authorizedExposureCount,
        state: this.registryStatus.state,
        status: this.registryStatus,
        durationMs: performance.now() - started,
      });
      return [...nextBindings.values()].map((binding) =>
        copy(binding.registered),
      );
    })();
    this.hydration = pending;
    try {
      return copy(await pending);
    } catch (error) {
      if (this.hydration === pending) this.hydration = undefined;
      throw error;
    } finally {
      if (version === this.registryVersion) this.hydrating = false;
    }
  }
  async recover(
    options: {
      serverIds?: string[];
      maxAttempts?: number;
      retryDelayMs?: number;
    } = {},
  ): Promise<{
    registry: RegisteredTool[];
    status: Readonly<RegistryStatusV2>;
    catalogChanged: boolean;
  }> {
    this.stopped.signal.throwIfAborted();
    if (this.activeCalls || this.hydrating)
      throw new Error("Finish active calls and hydration before reconnecting");
    if (
      options.maxAttempts !== undefined &&
      (!Number.isInteger(options.maxAttempts) ||
        options.maxAttempts < 1 ||
        options.maxAttempts > 5)
    )
      throw new Error("Invalid metadata recovery attempts");
    if (
      options.retryDelayMs !== undefined &&
      (!Number.isInteger(options.retryDelayMs) || options.retryDelayMs < 0)
    )
      throw new Error("Invalid metadata recovery delay");
    const before = stable(
      [...this.bindings].map(([name, binding]) => [
        name,
        binding.registered.inputSchema,
      ]),
    );
    const servers =
      options.serverIds ||
      [...this.connectorStatuses.values()]
        .filter(
          (server) =>
            server.state === "unavailable" || server.state === "empty",
        )
        .map((server) => server.server);
    for (const server of servers)
      if (!this.connectors.has(server))
        throw new Error("Recovery server is not attached and enabled");
    this.clearRouting();
    this.registryVersion++;
    this.hydration = undefined;
    for (const server of servers) {
      this.connectors.get(server)!.invalidate();
      this.metadataCache.delete(server);
      this.unavailable.delete(server);
      this.connectorStatuses.set(server, {
        server,
        state: "initializing",
        upstreamToolCount: 0,
        attempts: 0,
        updatedAt: new Date().toISOString(),
      });
    }
    const registry = await this.initializeRegistry(options);
    const catalogChanged =
      before !==
        stable(
          [...this.bindings].map(([name, binding]) => [
            name,
            binding.registered.inputSchema,
          ]),
        ) || (await this.dispatchCatalogChanged());
    this.event("recovery", {
      servers,
      catalogChanged,
      status: this.registryStatus,
    });
    return { registry, status: this.registryStatus, catalogChanged };
  }
  async dispatchCatalogChanged(): Promise<boolean> {
    if (this.servedCatalogFingerprint === undefined) return false;
    const exposed = [];
    for (const [name, binding] of this.bindings)
      if (await this.allowed(binding.registered))
        exposed.push([name, binding.registered.inputSchema]);
    return this.servedCatalogFingerprint !== stable(exposed);
  }
  setRouting(plan: Pick<RoutePlan, "mode" | "selected"> & { query?: string }) {
    if (!this.hydration) throw new Error("Hydrate the registry before routing");
    const selected = new Set<string>();
    for (const tool of plan.selected) {
      if (tool.sourceType === "native") continue;
      const binding = this.byId.get(tool.id);
      if (
        !binding ||
        tool.sourceType !== "mcp" ||
        tool.tenantId !== this.scope.tenantId ||
        tool.scope !== "tenant" ||
        binding.registered.serverId !== tool.serverId ||
        binding.registered.toolName !== tool.toolName ||
        (tool.bindingName &&
          binding.registered.bindingName !== tool.bindingName)
      )
        throw new Error("Route refers to an unavailable tool binding");
      selected.add(tool.id);
    }
    this.generation++;
    this.receipts.length = 0;
    this.platformProjections.clear();
    if (plan.mode === "direct_tools") {
      for (const id of selected) {
        const binding = this.byId.get(id)!;
        if (binding.registered.toolName !== "get_apps") continue;
        const fields = this.knownAppProjection(
          plan.query || "",
          binding.registered.serverId,
        );
        if (fields) this.platformProjections.set(id, fields);
        this.event("projection_policy", {
          bindingName: binding.registered.bindingName,
          fields: fields || null,
          generation: this.generation,
          policy: fields ? "platform" : "model",
          reason: fields
            ? "Known app-listing intent has a deterministic field policy"
            : "Explicit full output or unsupported field intent requires model selection",
        });
      }
    }
    this.routing = {
      mode: plan.mode,
      selected,
      query: plan.query || "",
      registryVersion: this.registryVersion,
    };
    this.event("routing", {
      generation: this.generation,
      mode: plan.mode,
      selected: [...selected],
      query: plan.query || "",
    });
  }
  clearRouting() {
    this.generation++;
    this.routing = undefined;
    this.receipts.length = 0;
    this.platformProjections.clear();
  }
  approveInvocation(name: string, args: Record<string, unknown>) {
    this.requireRoute();
    if (!this.bindings.has(name) && name !== "invoke_tool")
      throw new Error("Unknown approval binding");
    if (!isObject(args)) throw new Error("Invalid approval arguments");
    this.receipts.push({
      key: stable([name, copy(args), this.scope]),
      generation: this.generation,
      expiresAt: Date.now() + (this.options.receiptTtlMs || 30000),
    });
    this.event("approval", { name, generation: this.generation });
  }
  private consumeReceipt(name: string, args: Record<string, unknown>) {
    const key = stable([name, args, this.scope]);
    const now = Date.now();
    for (let i = this.receipts.length - 1; i >= 0; i--)
      if (
        this.receipts[i].expiresAt < now ||
        this.receipts[i].generation !== this.generation
      )
        this.receipts.splice(i, 1);
    const index = this.receipts.findIndex((receipt) => receipt.key === key);
    if (index < 0)
      throw new Error("This invocation requires its own explicit approval");
    this.receipts.splice(index, 1);
  }
  private requireRoute() {
    if (
      !this.routing ||
      this.routing.registryVersion !== this.registryVersion ||
      this.stopped.signal.aborted
    )
      throw new Error(
        "Routing is unavailable; hydrate and route before executing",
      );
    return this.routing;
  }
  invalidate(
    reason: GatewayInvalidationReasonV2,
    configs?: Record<string, ConnectorConfig>,
  ) {
    this.registryVersion++;
    this.generation++;
    this.routing = undefined;
    this.receipts.length = 0;
    this.hydration = undefined;
    this.platformProjections.clear();
    this.unavailable.clear();
    this.bindings.clear();
    this.byId.clear();
    this.metadataCache.clear();
    for (const active of this.requests.values())
      active.abort(new Error("Gateway configuration invalidated"));
    if (configs) {
      this.configs = copy(configs);
      this.replaceConnectors();
    } else {
      for (const [server, connector] of this.connectors) {
        connector.invalidate();
        this.connectorStatuses.set(server, {
          server,
          state: "initializing",
          upstreamToolCount: 0,
          attempts: 0,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    this.event("invalidate", {
      reason,
      registryVersion: this.registryVersion,
      newConversationCatalogRequired: true,
    });
  }
  private async execute(name: string, args: any, signal: AbortSignal) {
    const route = this.requireRoute(),
      generation = this.generation;
    if (!isObject(args)) throw new Error("Tool arguments must be an object");
    if (this.fallbackChecks.has(name)) {
      if (route.mode !== "discovery")
        throw new Error("Discovery tools are not exposed for this turn");
      if (!this.fallbackChecks.get(name)!(args))
        throw new Error("Invalid discovery arguments");
      const visible: Binding[] = [];
      for (const binding of this.bindings.values())
        if (await this.allowed(binding.registered)) visible.push(binding);
      if (generation !== this.generation)
        throw new Error("Routing changed during authorization");
      if (name === "discover_server") {
        const query = args.query.toLowerCase();
        return text({
          servers: [
            ...new Set(visible.map((binding) => binding.registered.serverId)),
          ]
            .filter(
              (server) =>
                !query ||
                query.includes(server.toLowerCase()) ||
                server.toLowerCase().includes(query),
            )
            .map((name) => ({ name })),
          unavailableServers: [...this.connectorStatuses.values()]
            .filter(
              (server) =>
                server.state === "unavailable" || server.state === "empty",
            )
            .filter(
              (server) =>
                !query ||
                query.includes(server.server.toLowerCase()) ||
                server.server.toLowerCase().includes(query),
            )
            .map((server) => ({
              name: server.server,
              state: server.state,
              error: server.lastError,
              retryable: server.lastError?.retryable || false,
            })),
          registryState: this.registryStatus.state,
        });
      }
      let matching = visible.filter(
        (binding) => binding.registered.serverId === args.server,
      );
      const serverStatus = this.connectorStatuses.get(args.server);
      if (
        serverStatus &&
        (serverStatus.state === "unavailable" || serverStatus.state === "empty")
      )
        throw new Error(
          `Attached connector ${args.server} is ${serverStatus.state}: ${serverStatus.lastError?.message || "No upstream tool schemas"}. Metadata recovery is required; this is not an empty successful discovery.`,
        );
      if (name === "discover_tools") {
        if (args.query) {
          const words = args.query.toLowerCase().split(/\W+/).filter(Boolean);
          matching = matching.filter((binding) =>
            words.some((word: string) =>
              `${binding.registered.toolName} ${binding.registered.description || ""}`
                .toLowerCase()
                .includes(word),
            ),
          );
        }
        const offset = args.cursor === undefined ? 0 : Number(args.cursor);
        if (!Number.isInteger(offset) || offset < 0)
          throw new Error("Invalid discovery cursor");
        const limit = args.limit || 100;
        return text({
          server: args.server,
          tools: matching.slice(offset, offset + limit).map((binding) => ({
            name: binding.registered.toolName,
            bindingName: binding.registered.bindingName,
            description: binding.registered.description?.slice(0, 240),
          })),
          totalMatched: matching.length,
          ...(offset + limit < matching.length
            ? { nextCursor: String(offset + limit) }
            : {}),
        });
      }
      const binding = matching.find(
        (entry) => entry.registered.toolName === args.tool,
      );
      if (!binding)
        throw new Error("Tool is not attached, enabled or authorized");
      if (name === "get_tool_schema")
        return text({
          server: args.server,
          tool: args.tool,
          inputSchema: binding.upstream.inputSchema,
          outputSchema: binding.upstream.outputSchema,
          annotations: binding.upstream.annotations,
          responseProjection:
            "invoke_tool.fields is required; use answer paths or ['*'] for explicit full output.",
        });
      this.consumeReceipt(name, args);
      return this.invoke(
        binding,
        args.arguments,
        args.fields,
        signal,
        generation,
      );
    }
    const binding = this.bindings.get(name);
    if (
      !binding ||
      route.mode !== "direct_tools" ||
      !route.selected.has(binding.registered.id)
    )
      throw new Error("Tool is not exposed for this turn");
    if (!binding.validate(args))
      throw new Error("Arguments do not match the exposed tool schema");
    const fields = args[binding.projectionProperty];
    const downstream = copy(args);
    delete downstream[binding.projectionProperty];
    if (
      binding.upstream.annotations?.readOnlyHint !== true ||
      binding.upstream.annotations?.destructiveHint === true
    )
      this.consumeReceipt(name, args);
    return this.invoke(binding, downstream, fields, signal, generation);
  }
  private async invoke(
    binding: Binding,
    args: Record<string, unknown>,
    requestedFields: unknown,
    signal: AbortSignal,
    generation: number,
  ) {
    if (!binding.validateUpstream(args))
      throw new Error("Arguments do not match the downstream tool schema");
    const ownedFields = this.platformProjections.get(binding.registered.id);
    const fields = ownedFields || requestedFields;
    if (!validFields(fields))
      throw new Error("Response projection fields are required");
    if (!(await this.allowed(binding.registered, true, args)))
      throw new Error("Current permissions deny this tool invocation");
    if (generation !== this.generation)
      throw new Error("Routing changed before execution");
    signal.throwIfAborted();
    const started = performance.now();
    let result: any;
    try {
      result = await this.connectors
        .get(binding.registered.serverId)!
        .call(binding.registered.toolName, args, signal);
    } catch (error: any) {
      if (
        !(error instanceof DownstreamRpcErrorV2) &&
        !(
          error instanceof McpTransportErrorV2 &&
          error.stage === "tools/call" &&
          ["timeout", "cancelled"].includes(error.kind)
        ) &&
        !signal.aborted &&
        !this.stopped.signal.aborted
      ) {
        const server = binding.registered.serverId,
          message = this.redactor.clean(
            String(error.message || "Connector unavailable"),
          );
        this.unavailable.set(server, message);
        const previous = this.connectorStatuses.get(server);
        this.connectorStatuses.set(server, {
          server,
          state: "unavailable",
          upstreamToolCount: previous?.upstreamToolCount || 0,
          attempts: previous?.attempts || 0,
          updatedAt: new Date().toISOString(),
          lastError: {
            message,
            kind: error instanceof McpTransportErrorV2 ? error.kind : "network",
            stage: "tools/call",
            retryable: false,
          },
        });
        for (const candidate of this.bindings.values())
          if (candidate.registered.serverId === server)
            candidate.registered = frozen({
              ...candidate.registered,
              available: false,
            });
        this.event("unavailable", { server, message, phase: "execution" });
      }
      this.event("invoke_error", {
        server: binding.registered.serverId,
        tool: binding.registered.toolName,
        durationMs: performance.now() - started,
        outcomeUnknown: true,
      });
      throw error;
    }
    let projected = result;
    if (!result.isError && !(fields.length === 1 && fields[0] === "*")) {
      const original = parseResult(result);
      if (!fields.some((field) => hasPath(original, field.split("."))))
        throw new Error(
          "Downstream action completed, but selected fields are absent. Do not repeat the action automatically.",
        );
      const data = projectFields(original, fields);
      this.preservePagination(original, data);
      projected = {
        ...text(data),
        ...(result.structuredContent !== undefined
          ? { structuredContent: data }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
    }
    const clean = this.redactor.clean(projected);
    this.event("invoke", {
      server: binding.registered.serverId,
      tool: binding.registered.toolName,
      bindingName: binding.registered.bindingName,
      arguments: args,
      fields,
      requestedFields: requestedFields ?? null,
      effectiveFields: fields,
      projectionPolicy: ownedFields ? "platform" : "model",
      generation,
      durationMs: performance.now() - started,
      inputBytes: Buffer.byteLength(JSON.stringify(result)),
      outputBytes: Buffer.byteLength(JSON.stringify(clean)),
      result,
      projected: clean,
    });
    return clean;
  }
  private appFields(query: string): string[] {
    const simpleNames =
      /\b(?:only|just)\b.*\b(?:names?|titles?)\b|\bapp names\b/i.test(query);
    const fields = simpleNames
      ? ["apps.name", "pagination"]
      : ["apps.name", "apps.guid", "apps.stream", "pagination"];
    if (/\b(?:guid|identifier|ids?)\b/i.test(query)) fields.push("apps.guid");
    if (/\bstreams?\b/i.test(query)) fields.push("apps.stream");
    if (
      /\b(?:modified|updated|recent|latest|dates?|timestamps?)\b/i.test(query)
    )
      fields.push(
        "apps.modified_dttm",
        "apps.modified",
        "apps.modifiedAt",
        "apps.updatedAt",
      );
    if (/\breload/i.test(query))
      fields.push("apps.reload_dttm", "apps.reloadAt");
    if (/\bdescriptions?\b/i.test(query)) fields.push("apps.description");
    return [...new Set(fields)];
  }
  private knownAppProjection(
    query: string,
    server: string,
  ): string[] | undefined {
    if (!query.trim() || !/\bapps?\b|\bapplications?\b/i.test(query)) return;
    if (
      /\braw\b|\b(?:full|original)\s+(?:response|output|result|payload|metadata)\b|\ball\s+(?:fields|attributes|metadata|columns)\b/i.test(
        query,
      )
    )
      return;
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const allowed = new Set(
      "i can could would will you please bro need want give get show list down the what all apps app applications application in on from of available connected system as a table and with their only just names name titles title guid guids ids id identifier identifiers stream streams description descriptions modified updated recently recent latest date dates timestamp timestamps reload reloaded last by sorted sort descending ascending which are my our me to is there these".split(
        " ",
      ),
    );
    for (const word of server
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean))
      allowed.add(word);
    // Unknown words can name explicitly requested fields; never silently discard them.
    if (words.some((word) => !allowed.has(word))) return;
    return this.appFields(query);
  }
  private preservePagination(original: any, projected: any) {
    const keys = new Set([
      "pagination",
      "pageInfo",
      "nextCursor",
      "next_cursor",
      "nextPage",
      "next_page",
      "total",
      "totalCount",
      "total_count",
      "total_found",
      "hasMore",
      "has_more",
      "next_offset",
    ]);
    if (Array.isArray(original) && Array.isArray(projected)) {
      for (let i = 0; i < original.length; i++)
        this.preservePagination(original[i], projected[i]);
      return;
    }
    if (!isObject(original) || !isObject(projected)) return;
    for (const [key, value] of Object.entries(original)) {
      if (keys.has(key)) projected[key] = copy(value);
      else if (Object.hasOwn(projected, key))
        this.preservePagination(value, projected[key]);
      else if (
        ["data", "meta", "metadata", "result"].includes(key) &&
        isObject(value)
      ) {
        const nested: Record<string, unknown> = {};
        this.preservePagination(value, nested);
        if (Object.keys(nested).length) projected[key] = nested;
      }
    }
  }
  private reserveCall() {
    const now = Date.now();
    while (this.callTimes.length && this.callTimes[0] <= now - 60000)
      this.callTimes.shift();
    if (
      this.callTimes.length >= (this.options.maxCallsPerMinute || 120) ||
      this.activeCalls >= (this.options.maxConcurrentCalls || 8)
    )
      throw new Error("Gateway rate limit exceeded");
    this.callTimes.push(now);
    this.activeCalls++;
  }
  async start(): Promise<{
    url: string;
    http_headers: Record<string, string>;
    default_tools_approval_mode: string;
    tools: Record<string, any>;
  }> {
    await this.initializeRegistry();
    this.stopped.signal.throwIfAborted();
    if (!this.starting)
      this.starting = (async () => {
        this.server = createServer(async (req, res) => {
          const auth = req.headers.authorization || "",
            expected = `Bearer ${this.authToken}`;
          if (
            req.url !== "/mcp" ||
            req.headers.origin ||
            Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
          ) {
            res.writeHead(403).end();
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end();
            return;
          }
          let id: any = null;
          const cancelled = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) cancelled.abort();
          });
          try {
            let bytes = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > MAX_BYTES) {
                res.writeHead(413).end();
                return;
              }
              chunks.push(Buffer.from(chunk));
            }
            const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!isObject(rpc) || rpc.jsonrpc !== "2.0")
              throw new Error("Invalid JSON-RPC message");
            if (rpc.id === undefined) {
              if (rpc.method === "notifications/cancelled")
                this.requests.get(stable(rpc.params?.requestId))?.abort();
              res.writeHead(202).end();
              return;
            }
            id = rpc.id;
            let result: any;
            if (rpc.method === "initialize")
              result = {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "truex-adaptive-v2", version: "0.1.0" },
              };
            else if (rpc.method === "tools/list") {
              const definitions: any[] = [];
              for (const binding of this.bindings.values())
                if (await this.allowed(binding.registered))
                  definitions.push({
                    name: binding.registered.bindingName,
                    description: binding.registered.description,
                    inputSchema: binding.registered.inputSchema,
                    annotations: binding.registered.annotations,
                  });
              this.servedCatalogFingerprint = stable(
                definitions.map((tool) => [tool.name, tool.inputSchema]),
              );
              result = {
                tools: [...definitions, ...copy(this.fallbackDefinitions)],
              };
            } else if (rpc.method === "ping") result = {};
            else if (rpc.method === "tools/call") {
              let reserved = false;
              try {
                this.reserveCall();
                reserved = true;
                this.requests.set(stable(id), cancelled);
                this.event("call", {
                  name: rpc.params?.name,
                  arguments: rpc.params?.arguments,
                  generation: this.generation,
                });
                result = await this.execute(
                  rpc.params?.name,
                  rpc.params?.arguments,
                  AbortSignal.any([cancelled.signal, this.stopped.signal]),
                );
              } catch (error: any) {
                const message = this.redactor.clean(String(error.message));
                this.event("error", { name: rpc.params?.name, message });
                result = {
                  ...text(
                    error instanceof DownstreamRpcErrorV2
                      ? { error: this.redactor.clean(error.detail) }
                      : { error: message },
                  ),
                  isError: true,
                };
              } finally {
                if (reserved) {
                  this.activeCalls--;
                  this.requests.delete(stable(id));
                }
              }
            } else {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Method not supported" },
                }),
              );
              return;
            }
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: this.cleanMetadata(result),
              }),
            );
          } catch {
            if (!res.headersSent)
              res.writeHead(400, { "content-type": "application/json" }).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32600, message: "Invalid MCP request" },
                }),
              );
          }
        });
        this.server.listen(0, "127.0.0.1");
        await once(this.server, "listening");
        this.endpoint = `http://127.0.0.1:${(this.server.address() as any).port}/mcp`;
      })();
    await this.starting;
    return {
      url: this.endpoint!,
      http_headers: { Authorization: `Bearer ${this.authToken}` },
      default_tools_approval_mode: "prompt",
      // Like Omni, metadata-only discovery needs no consent; invocations still prompt.
      tools: Object.fromEntries([
        ...[...this.bindings.keys()].map((name) => [
          name,
          { approval_mode: "prompt" },
        ]),
        ...this.fallbackDefinitions.map((tool) => [
          tool.name,
          {
            approval_mode: tool.name === "invoke_tool" ? "prompt" : "approve",
          },
        ]),
      ]),
    };
  }
  close() {
    this.stopped.abort();
    this.receipts.length = 0;
    this.routing = undefined;
    this.platformProjections.clear();
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
