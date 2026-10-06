import {
  AdaptiveMcpGatewayV2,
  type AdaptiveGatewayScope,
  type AdaptiveMcpGatewayV2Options,
} from "./adaptive-mcp-gateway-v2";
import { AdaptiveModelBoundaryV2 } from "./adaptive-model-boundary-v2";
import {
  GlobalToolRegistry,
  ToolRouter,
  type RegisteredTool,
  type RoutePlan,
  type RoutingContext,
  type ToolRouterOptions,
} from "./tool-router-v2";
import type { ConnectorConfig, GatewayEvent } from "./omni-mcp-gateway";

export interface AdaptiveSessionOptionsV2 {
  scope: AdaptiveGatewayScope;
  /** Use the same current AgentCore/platform policy for exposure and execution. */
  authorize: (
    tool: RegisteredTool,
    scope: Readonly<AdaptiveGatewayScope>,
    args?: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  routing?: ToolRouterOptions;
  hydration?: AdaptiveMcpGatewayV2Options["hydration"];
  /** Host-only: refresh the existing runtime dispatch catalog while retaining this thread. */
  refreshDispatchCatalog?: () => Promise<void>;
  fetch?: typeof fetch;
  onEvent?: (event: GatewayEvent) => void;
}

/**
 * External integration entry point. Give each authorized conversation its own
 * instance. Configs must come from PlatformService.configuration, never the user
 * or a model tool argument. Native dispatch remains with BusinessRuntime.
 */
export class AdaptiveSessionV2 {
  readonly registry = new GlobalToolRegistry();
  readonly gateway: AdaptiveMcpGatewayV2;
  readonly router: ToolRouter;
  readonly boundary: AdaptiveModelBoundaryV2;
  private plan?: RoutePlan;
  private context: RoutingContext = {};
  private activeQuery = "";
  private closed = false;
  private exposedNames?: ReadonlySet<string>;
  private nativeReady = false;
  private dispatchRefreshRequired = false;
  constructor(
    private configs: Record<string, ConnectorConfig>,
    private readonly options: AdaptiveSessionOptionsV2,
  ) {
    if (
      !options.scope?.tenantId ||
      !options.scope.userId ||
      typeof options.authorize !== "function"
    )
      throw new Error(
        "Adaptive integration requires an authenticated scope and current authorization callback",
      );
    this.configs = structuredClone(configs);
    const authorize = (tool: RegisteredTool, args?: Record<string, unknown>) =>
      options.authorize(tool, this.gateway.scope, args);
    this.gateway = new AdaptiveMcpGatewayV2(
      configs,
      (event) => {
        if (event.type === "unavailable" && typeof event.server === "string")
          this.registry.invalidate(event.server, this.gateway.scope.tenantId);
        if (
          event.type === "invoke" &&
          typeof event.server === "string" &&
          typeof event.tool === "string" &&
          (event.projected as any)?.isError !== true
        ) {
          this.context.recentServerIds = [event.server];
          this.context.recentToolIds = [
            JSON.stringify([event.server, event.tool]),
          ];
          this.context.activeServerId = event.server;
          this.rememberEntities(event.server, event.projected);
        }
        this.emit(event);
      },
      options.fetch || fetch,
      {
        scope: options.scope,
        hydration: options.hydration,
        authorizeExposure: (tool) => authorize(tool),
        authorizeExecution: (tool, args) => authorize(tool, args),
      },
    );
    this.router = new ToolRouter(
      this.registry,
      (tool) => authorize(tool),
      options.routing,
    );
    this.boundary = new AdaptiveModelBoundaryV2({
      ...options.scope,
      authorizeMcp: (tool) => authorize(tool),
      authorizeNative: (tool) => authorize(tool),
    });
  }
  private open() {
    if (this.closed) throw new Error("Adaptive session is closed");
  }
  private emit(event: GatewayEvent) {
    try {
      this.options.onEvent?.(event);
    } catch {
      // An observer cannot interrupt authorization or cause an action to repeat.
    }
  }
  private rememberEntities(serverId: string, result: any) {
    // Compact routing hints only. Keep duplicate names with distinct identifiers.
    // These are neither model history nor permission/approval decisions.
    let data = result?.structuredContent;
    if (data == null && result?.content?.[0]?.type === "text") {
      try {
        data = JSON.parse(result.content[0].text);
      } catch {
        return;
      }
    }
    if (!Array.isArray(data?.apps)) return;
    const entities = data.apps
      .filter(
        (app: any) =>
          typeof app?.name === "string" &&
          app.name.length <= 512 &&
          typeof app?.guid === "string" &&
          app.guid.length <= 256,
      )
      .slice(0, 50)
      .map((app: any) => ({
        kind: "application",
        serverId,
        guid: app.guid,
        name: app.name,
        ...(typeof app.stream === "string" && app.stream.length <= 512
          ? { stream: app.stream }
          : {}),
      }));
    if (entities.length) this.context.activeEntities = entities;
  }
  private syncRegistry(tools: RegisteredTool[]) {
    for (const server of new Set([
      ...Object.keys(this.configs),
      ...tools.map((tool) => tool.serverId),
    ]))
      this.registry.replaceServer(
        server,
        tools.filter((tool) => tool.serverId === server),
        this.options.scope.tenantId,
      );
  }
  private routingContext(extra?: RoutingContext): RoutingContext {
    const health = this.gateway.registryStatus;
    return {
      ...this.context,
      ...extra,
      allowedServerIds: Object.keys(this.configs).filter(
        (server) => this.configs[server].enabled !== false,
      ),
      registryState: health.state,
      unavailableServerIds: [...this.gateway.unavailableServers.keys()],
    };
  }
  private async recoverMetadata() {
    const recovery = await this.gateway.recover();
    this.open();
    this.syncRegistry(recovery.registry);
    if (recovery.catalogChanged) this.dispatchRefreshRequired = true;
    if (this.dispatchRefreshRequired) {
      // The pinned runtime retains a dispatch catalog. Never expose new schemas
      // until the host has refreshed it through its existing authorized reload.
      if (!this.options.refreshDispatchCatalog)
        throw new Error(
          "Adaptive catalog changed; a host dispatch refresh is required before routing",
        );
      await this.options.refreshDispatchCatalog();
      this.dispatchRefreshRequired = false;
    }
    return recovery;
  }
  async recoverRegistry() {
    this.open();
    if (this.activeQuery)
      throw new Error("Finish the current turn before recovering the registry");
    return this.recoverMetadata();
  }
  async start() {
    this.open();
    this.syncRegistry(await this.gateway.initializeRegistry());
    return this.gateway.start();
  }
  async beforeTurn(
    query: string,
    context?: RoutingContext,
  ): Promise<RoutePlan> {
    this.open();
    if (this.activeQuery)
      throw new Error(
        "Finish the current turn before starting another adaptive turn",
      );
    this.activeQuery = query;
    try {
      if (await this.gateway.dispatchCatalogChanged())
        this.dispatchRefreshRequired = true;
      if (this.dispatchRefreshRequired) {
        if (!this.options.refreshDispatchCatalog)
          throw new Error(
            "Adaptive catalog changed; a host dispatch refresh is required before routing",
          );
        await this.options.refreshDispatchCatalog();
        this.dispatchRefreshRequired = false;
      }
      const request = () => ({
        query,
        ...this.options.scope,
        context: this.routingContext(context),
      });
      this.plan = await this.router.route(request());
      if (this.plan.fallbackCode === "registry_unavailable") {
        await this.recoverMetadata();
        this.plan = await this.router.route(request());
      }
      this.open();
      this.gateway.setRouting(this.plan);
      this.emit({
        type: "platform_routing",
        at: new Date().toISOString(),
        registry: this.gateway.registryStatus,
        ...this.plan,
        permissionRejectedToolIds: this.plan.authorizationRemoved,
      });
      return this.plan;
    } catch (error) {
      this.gateway.clearRouting();
      this.activeQuery = "";
      this.plan = undefined;
      throw error;
    }
  }
  async filterModelRequest(body: any) {
    this.open();
    if (!this.plan || !this.activeQuery)
      throw new Error("Route a user turn before making a model request");
    if (!this.nativeReady) {
      const native = this.boundary.nativeRegistry(body);
      this.registry.replaceServer(
        "native",
        native,
        this.options.scope.tenantId,
      );
      this.nativeReady = true;
    }
    // Authorization is evaluated again at this request boundary. Do not reset
    // invocation receipts during continuation calls of the same model turn.
    const filtered = await this.boundary.filter(
      body,
      this.plan,
      this.gateway.exposedNames,
    );
    this.exposedNames = filtered.allowedNames;
    this.emit({
      type: "model_exposure",
      at: new Date().toISOString(),
      ...filtered.trace,
    });
    return filtered;
  }
  guardModelResponse(
    response: Response,
    allowedNames = this.exposedNames,
    onInvocation?: (item: any) => void,
  ) {
    if (!allowedNames)
      throw new Error(
        "A model request must be filtered before its response is accepted",
      );
    return this.boundary.guard(response, allowedNames, onInvocation);
  }
  /** Call only after the existing approval UI confirms this exact invocation. */
  approveInvocation(name: string, args: Record<string, unknown>) {
    this.open();
    this.gateway.approveInvocation(name, args);
  }
  finishTurn() {
    this.activeQuery = "";
    this.plan = undefined;
    this.exposedNames = undefined;
    this.gateway.clearRouting();
  }
  async invalidate(
    reason: "reconnect" | "schema" | "config" | "permission" | "enable",
    configs?: Record<string, ConnectorConfig>,
  ) {
    this.open();
    this.finishTurn();
    this.context = {};
    this.nativeReady = false;
    if (configs) this.configs = structuredClone(configs);
    this.gateway.invalidate(reason, configs);
    this.registry.invalidate();
    this.syncRegistry(await this.gateway.initializeRegistry());
    if (
      Object.keys(this.configs).some(
        (server) => this.configs[server].enabled !== false,
      )
    ) {
      this.dispatchRefreshRequired = true;
      if (!this.options.refreshDispatchCatalog)
        throw new Error(
          "Adaptive invalidation requires a host dispatch refresh before routing",
        );
      await this.options.refreshDispatchCatalog();
      this.dispatchRefreshRequired = false;
    }
  }
  close() {
    this.closed = true;
    this.finishTurn();
    this.context = {};
    this.registry.invalidate();
    this.gateway.close();
  }
}
