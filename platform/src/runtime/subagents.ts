import { SUB_AGENT_ID } from "../public/fields";
import { ApiError } from "../core/errors";

const DELEGATION_MODES = ["explicitRequestOnly", "proactive"];

// Optional helper-agent limits chosen when a conversation starts.
export function subAgentOptions(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "subAgents must be an object", "INVALID_INPUT");
  const { mode, maxConcurrent } = value as Record<string, unknown>;
  if (mode !== undefined && !DELEGATION_MODES.includes(mode as string))
    throw new ApiError(
      400,
      "subAgents.mode must be explicitRequestOnly or proactive",
      "INVALID_INPUT",
    );
  if (
    maxConcurrent !== undefined &&
    !(
      Number.isInteger(maxConcurrent) &&
      (maxConcurrent as number) >= 1 &&
      (maxConcurrent as number) <= 5
    )
  )
    throw new ApiError(
      400,
      "subAgents.maxConcurrent must be a whole number from 1 to 5",
      "INVALID_INPUT",
    );
  return {
    ...(mode !== undefined ? { mode: mode as string } : {}),
    ...(maxConcurrent !== undefined
      ? { maxConcurrent: maxConcurrent as number }
      : {}),
  };
}

export function validAgentId(agentId: string) {
  if (typeof agentId !== "string" || !SUB_AGENT_ID.test(agentId))
    throw new ApiError(400, "Invalid helper agent id", "INVALID_INPUT");
  return agentId;
}
