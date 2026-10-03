import {
  AdaptiveSessionV2,
  type AdaptiveSessionOptionsV2,
} from "./adaptive-session-v2";
import {
  routingModeV2,
  type RoutingModeV2,
} from "./adaptive-model-boundary-v2";
import {
  OmniMcpGateway,
  omniInstructions,
  type ConnectorConfig,
} from "./omni-mcp-gateway";

export interface PreparedMcpRoutingV2 {
  mode: RoutingModeV2;
  mcpServers: Record<string, ConnectorConfig>;
  instructions: string;
  session?: AdaptiveSessionV2;
  gateway?: OmniMcpGateway;
  close(): void;
}

/** New operator entry point; importing this module never changes production configuration. */
export async function prepareMcpRoutingV2(
  configs: Record<string, ConnectorConfig>,
  options: AdaptiveSessionOptionsV2 & {
    mode?: RoutingModeV2;
    requireProjection?: boolean;
  },
): Promise<PreparedMcpRoutingV2> {
  const mode = routingModeV2(options.mode);
  if (mode === "direct")
    return {
      mode,
      mcpServers: structuredClone(configs),
      instructions: "",
      close() {},
    };
  // Avoid wrapping a prepared gateway again through the legacy environment switch.
  if (process.env.TRUEX_MCP_GATEWAY_MODE === "omni")
    throw new Error(
      "V2 prepared profiles require TRUEX_MCP_GATEWAY_MODE=direct; the V2 entry point owns the selected routing mode",
    );
  if (mode === "omni") {
    const gateway = new OmniMcpGateway(
      configs,
      options.onEvent,
      options.fetch || fetch,
      { requireProjection: options.requireProjection },
    );
    try {
      return {
        mode,
        mcpServers: { omni: await gateway.start() },
        instructions: omniInstructions,
        gateway,
        close() {
          gateway.close();
        },
      };
    } catch (error) {
      gateway.close();
      throw error;
    }
  }
  const session = new AdaptiveSessionV2(configs, options);
  try {
    return {
      mode,
      mcpServers: { adaptive: await session.start() },
      session,
      instructions:
        "\nUse the business tools exposed for this turn. The platform has already selected applicable tools. When discovery tools are exposed, use them to resolve the ambiguous request. Greetings and general knowledge need no business connector calls. Projection never authorizes a business operation.",
      close() {
        session.close();
      },
    };
  } catch (error) {
    session.close();
    throw error;
  }
}
