import type { RegisteredTool } from "./tool-router-v2";
import { mcpMethod } from "./mcp-method";

export type RoutingModeV2 = "direct" | "omni" | "adaptive";
export function routingModeV2(
  value: string | undefined = undefined,
): RoutingModeV2 {
  if (value === undefined) {
    const method = mcpMethod();
    return method === "adaptive_v2" ? "adaptive" : method;
  }
  if (value === "") return "direct";
  if (value === "direct" || value === "omni" || value === "adaptive")
    return value;
  throw new Error("MCP_ROUTING_MODE must be direct, omni or adaptive");
}

type Plan = {
  mode: "no_tools" | "direct_tools" | "discovery";
  query: string;
  selected: RegisteredTool[];
};
type Options = {
  tenantId: string;
  userId: string;
  gatewayNamespace?: string;
  authorizeMcp?: (tool: RegisteredTool) => boolean | Promise<boolean>;
  authorizeNative?: (tool: RegisteredTool) => boolean | Promise<boolean>;
  /** Carry only recent native capability names for an unresolved follow-up. */
  recentNativeNames?: string[];
};
const discovery = new Set([
  "discover_server",
  "discover_tools",
  "get_tool_schema",
  "invoke_tool",
]);
const mandatory = new Set(["update_plan", "request_user_input"]);
const goals = new Set(["get_goal", "create_goal", "update_goal"]);
const helpers = new Set([
  "spawn_agent",
  "wait_agent",
  "send_input",
  "resume_agent",
  "close_agent",
]);
const resources = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);
const files = new Set([
  "conversation_files",
  "read_conversation_file",
  "create_document",
]);
const workspace = new Set([
  "write_file",
  "append_file",
  "edit_file",
  "read_file",
  "list_files",
  "search_files",
  "delete_file",
  "export_workspace_file",
]);
const optional = new Set([
  ...goals,
  ...helpers,
  ...resources,
  ...files,
  ...workspace,
  "create_visualization",
  "web_search",
  "tool_search",
]);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const identity = (name: string, namespace?: string) =>
  namespace ? `${namespace}::${name}` : name;

export function flattenModelToolsV2(
  tools: any[] = [],
): { tool: any; namespace?: string }[] {
  return tools.flatMap((tool) =>
    tool?.type === "namespace"
      ? (tool.tools || []).map((inner: any) => ({
          tool: inner,
          namespace: tool.name,
        }))
      : [{ tool }],
  );
}

/** No registry, credentials or hidden binding metadata is added to the model body. */
export class AdaptiveModelBoundaryV2 {
  constructor(private readonly options: Options) {}

  nativeRegistry(body: any): RegisteredTool[] {
    return flattenModelToolsV2(body.tools)
      .filter(({ namespace }) => !namespace?.startsWith("mcp__"))
      .map(({ tool, namespace }) => ({
        id: JSON.stringify(["native", namespace || "", tool.name || tool.type]),
        serverId: "native",
        serverName: "AgentCore",
        toolName: tool.name || tool.type,
        description: tool.description || "",
        inputSchema: tool.parameters || { type: "object", properties: {} },
        sourceType: "native",
        tenantId: this.options.tenantId,
        enabled: true,
        tags: [namespace || "native"],
        mandatory: mandatory.has(tool.name),
      }));
  }

  private nativeRelevant(name: string, query: string) {
    if (mandatory.has(name)) return true;
    // Preserve unfamiliar runtime controls. A new Codex release must not silently
    // lose a required capability just because this experimental selector is old.
    if (!optional.has(name)) return true;
    const q = query.toLowerCase();
    if (
      /\b(these|those|it|them|ones|continue|again)\b/.test(q) &&
      this.options.recentNativeNames?.includes(name)
    )
      return true;
    if (goals.has(name)) return /\bgoal\b/.test(q);
    if (helpers.has(name))
      return /\b(sub.?agents?|delegate|parallel|helpers?)\b/.test(q);
    if (resources.has(name))
      return /\b(mcp resources?|resource templates?|connector resources?)\b/.test(
        q,
      );
    if (name === "create_visualization")
      return /\b(visuali[sz]e|interactive|diagram|chart|simulation)\b/.test(q);
    if (files.has(name))
      return /\b(upload|uploaded|attachment|document|pdf|word|excel|xlsx|pptx|powerpoint|spreadsheet|slides)\b/.test(
        q,
      );
    if (workspace.has(name))
      return /\b(workspace|files?|code|script|program|implement|repository|save|export)\b/.test(
        q,
      );
    if (name === "web_search")
      return /\b(latest|current|today|news|browse|search the web|look up)\b/.test(
        q,
      );
    if (name === "tool_search")
      return /\b(find tools?|discover tools?)\b/.test(q);
    return false;
  }

  async filter(
    body: any,
    plan: Plan,
    bindings: ReadonlyMap<string, RegisteredTool>,
  ) {
    if (!body || !Array.isArray(body.tools))
      throw new Error("Invalid Responses tool catalog");
    const namespace = this.options.gatewayNamespace || "mcp__adaptive";
    const selected = new Set(
      plan.selected.filter((t) => t.sourceType === "mcp").map((t) => t.id),
    );
    const natives = new Map(this.nativeRegistry(body).map((t) => [t.id, t]));
    const removedByAuthorization: string[] = [],
      selectedNative: string[] = [],
      controls: string[] = [];
    const allowedNames = new Set<string>();
    const accept = async (tool: any, parent?: string): Promise<boolean> => {
      const name = tool.name || tool.type;
      if (parent?.startsWith("mcp__")) {
        if (parent !== namespace) return false;
        const registered = bindings.get(name);
        let allowed =
          plan.mode === "discovery"
            ? discovery.has(name)
            : plan.mode === "direct_tools" &&
              !!registered &&
              selected.has(registered.id) &&
              registered.enabled !== false &&
              registered.tenantId === this.options.tenantId &&
              registered.available !== false;
        if (
          allowed &&
          registered &&
          this.options.authorizeMcp &&
          !(await this.options.authorizeMcp(registered))
        ) {
          removedByAuthorization.push(identity(name, parent));
          allowed = false;
        }
        if (allowed) allowedNames.add(identity(name, parent));
        return allowed;
      }
      const registered = natives.get(
        JSON.stringify(["native", parent || "", name]),
      )!;
      const control = mandatory.has(name) || !optional.has(name);
      if (!control && !this.nativeRelevant(name, plan.query)) return false;
      if (
        !control &&
        this.options.authorizeNative &&
        !(await this.options.authorizeNative(registered))
      ) {
        removedByAuthorization.push(name);
        return false;
      }
      allowedNames.add(identity(name, parent));
      (control ? controls : selectedNative).push(name);
      return true;
    };
    const tools: any[] = [];
    const currentSchema = (member: any, parent: string) => {
      const registered =
        parent === namespace ? bindings.get(member.name) : undefined;
      return registered
        ? {
            ...member,
            parameters: registered.inputSchema,
            description: `${registered.serverName || registered.serverId}: ${registered.description || member.description || ""}`,
          }
        : member;
    };
    for (const tool of body.tools) {
      if (tool.type === "namespace") {
        const members = [];
        for (const member of tool.tools || [])
          if (await accept(member, tool.name))
            members.push(currentSchema(member, tool.name));
        if (members.length) tools.push({ ...tool, tools: members });
      } else if (await accept(tool)) tools.push(tool);
    }
    const filtered = { ...body, tools };
    // A named forced choice must never retain a removed schema.
    if (
      body.tool_choice?.name &&
      !allowedNames.has(
        identity(body.tool_choice.name, body.tool_choice.namespace),
      )
    )
      throw new Error("Forced model tool is outside the current route");
    return {
      body: filtered,
      allowedNames,
      trace: {
        routingMode: plan.mode,
        query: plan.query,
        beforeSchemaCount: flattenModelToolsV2(body.tools).length,
        exposedSchemaCount: flattenModelToolsV2(tools).length,
        schemaBytesBefore: bytes(body.tools),
        schemaBytesAfter: bytes(tools),
        schemaCharsAfter: JSON.stringify(tools).length,
        finalExposedTools: [...allowedNames],
        mandatoryRuntimeTools: controls,
        selectedNativeTools: selectedNative,
        nativeAuthorizationRemoved: removedByAuthorization,
      },
    };
  }

  /** Check emitted actions before Codex receives them; leave history untouched. */
  guard(
    response: Response,
    allowedNames: ReadonlySet<string>,
    onInvocation?: (item: any) => void,
  ): Response {
    if (!response.ok || !response.body) return response;
    const inspect = (event: any) => {
      const items = [
        event?.item,
        ...(event?.response?.output || []),
        ...(event?.output || []),
      ].filter(Boolean);
      for (const item of items)
        if (["function_call", "custom_tool_call"].includes(item.type)) {
          if (
            typeof item.name !== "string" ||
            !allowedNames.has(identity(item.name, item.namespace))
          )
            throw new Error(
              "Provider returned a tool outside the current exposed set",
            );
          if (event.type !== "response.output_item.added") onInvocation?.(item);
        }
    };
    const sse = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    const decoder = new TextDecoder(),
      encoder = new TextEncoder();
    let pending = "";
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(pending) > 8 * 1024 * 1024)
          throw new Error("Model event exceeds 8 MiB");
        if (!sse) return;
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(pending))) {
          const block = pending.slice(0, separator.index);
          pending = pending.slice(separator.index + separator[0].length);
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") inspect(JSON.parse(data));
          controller.enqueue(encoder.encode(block + "\n\n"));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (!sse) {
          if (pending) inspect(JSON.parse(pending));
          controller.enqueue(encoder.encode(pending));
        } else if (pending.trim()) {
          const data = pending
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") inspect(JSON.parse(data));
          controller.enqueue(encoder.encode(pending));
        }
      },
    });
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
