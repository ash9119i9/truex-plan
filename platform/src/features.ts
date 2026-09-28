import type { ApprovalMode, ApprovalModesConfig } from "../../shared/contracts";
import { APPROVAL_MODES } from "../../shared/contracts";
import { ApiError } from "./errors";

const on = (value: string | undefined) => value?.trim().toLowerCase() === "on";

// Alpha approval modes. Off keeps today's behaviour everywhere.
export function approvalModesConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApprovalModesConfig {
  const autopilot = on(env.APPROVAL_MODES_AUTOPILOT);
  const requested = env.APPROVAL_MODES_DEFAULT?.trim() as ApprovalMode;
  const defaultMode =
    APPROVAL_MODES.includes(requested) && (requested !== "auto" || autopilot)
      ? requested
      : "ask";
  return {
    enabled: on(env.APPROVAL_MODES),
    defaultMode,
    autopilot,
    nameHeuristic: on(env.APPROVAL_NAME_HEURISTIC),
  };
}

export function isAllowedMode(
  mode: unknown,
  config: ApprovalModesConfig,
): mode is ApprovalMode {
  return (
    APPROVAL_MODES.includes(mode as ApprovalMode) &&
    (mode !== "auto" || config.autopilot)
  );
}

// A stored mode the current configuration no longer allows falls back.
export function effectiveMode(
  mode: unknown,
  config: ApprovalModesConfig,
): ApprovalMode {
  return isAllowedMode(mode, config) ? mode : config.defaultMode;
}

export function approvalMode(
  mode: unknown,
  config: ApprovalModesConfig,
): ApprovalMode {
  if (!isAllowedMode(mode, config))
    throw new ApiError(
      422,
      `Approval mode must be one of: ${APPROVAL_MODES.filter(
        (m) => m !== "auto" || config.autopilot,
      ).join(", ")}`,
      "INVALID_APPROVAL_MODE",
    );
  return mode;
}
