import type { ModelRoute, WireApi } from "../../shared/contracts";
import { WIRE_APIS } from "../../shared/contracts";
import type { ModelDocument } from "./documents";
import { ApiError } from "./errors";

export interface ResolvedRoute {
  wireApi: WireApi;
  route: ModelRoute;
}

// Responses providers talk to Codex directly; every other wire API needs the
// gateway to translate. `route` may force a Responses provider through it.
export function resolveRoute(profile: ModelDocument): ResolvedRoute {
  const wireApi = (profile.wireApi || "responses") as WireApi;
  if (!WIRE_APIS.includes(wireApi))
    throw new ApiError(
      422,
      `Model profile ${String(profile._id)} uses unknown wireApi "${profile.wireApi}". Use one of: ${WIRE_APIS.join(", ")}.`,
      "UNSUPPORTED_WIRE_API",
    );
  if (
    profile.route &&
    profile.route !== "direct" &&
    profile.route !== "gateway"
  )
    throw new ApiError(
      422,
      `Model profile ${String(profile._id)} uses unknown route "${profile.route}". Use "direct" or "gateway".`,
      "UNSUPPORTED_MODEL_ROUTE",
    );
  if (profile.route === "direct" && wireApi !== "responses")
    throw new ApiError(
      422,
      `Model profile ${String(profile._id)} uses wireApi "${wireApi}", which requires the model gateway. Remove route or set it to "gateway".`,
      "UNSUPPORTED_MODEL_ROUTE",
    );
  return {
    wireApi,
    route:
      (profile.route as ModelRoute | undefined) ||
      (wireApi === "responses" ? "direct" : "gateway"),
  };
}

export interface GatewaySettings {
  url: string;
  secret: string;
}

export function gatewaySettings(
  env: NodeJS.ProcessEnv = process.env,
): GatewaySettings | null {
  const url = env.MODEL_GATEWAY_URL?.replace(/\/+$/, "");
  const secret = env.MODEL_GATEWAY_SECRET;
  return url && secret ? { url, secret } : null;
}

export {
  signGatewayToken,
  verifyGatewayToken,
} from "../../shared/gateway-token";
