import type {
  ApprovalMode,
  ApprovalModesConfig,
} from "../../../shared/contracts";
import { approvalMode } from "../core/features";
import { ApiError } from "../core/errors";

export type CreationApprovalOptions = {
  approvalMode?: ApprovalMode;
  approvalNameHeuristic?: boolean;
};

// Validate before configuration lookups or runtime provisioning. Omitting the
// choice preserves existing feature-off and configured-default behavior.
export function creationApprovalOptions(
  requested: unknown,
  config: ApprovalModesConfig,
): CreationApprovalOptions {
  if (!config.enabled) {
    if (requested !== undefined)
      throw new ApiError(
        404,
        "Approval modes are not enabled",
        "FEATURE_DISABLED",
      );
    return {};
  }
  return {
    approvalMode:
      requested === undefined
        ? config.defaultMode
        : approvalMode(requested, config),
    approvalNameHeuristic: config.nameHeuristic,
  };
}

// Older runtimes return no create/resume acknowledgment. Confirm with their
// existing update endpoint before persisting the selected mode or dispatching.
// A contradictory acknowledgment is a protocol failure, not a silent fallback.
export async function confirmRuntimeApproval(
  response: unknown,
  options: CreationApprovalOptions,
  confirmLegacy: (mode: ApprovalMode) => Promise<unknown>,
): Promise<void> {
  const wanted = options.approvalMode;
  const applied =
    response && typeof response === "object" && "approvalMode" in response
      ? response.approvalMode
      : undefined;
  if (wanted === undefined || applied === wanted) return;
  if (applied === undefined) {
    const response = await confirmLegacy(wanted);
    if (
      response &&
      typeof response === "object" &&
      "mode" in response &&
      response.mode === wanted
    )
      return;
  }
  throw new ApiError(
    502,
    "The runtime did not confirm the requested approval mode. Retry before sending.",
    "APPROVAL_MODE_UNCONFIRMED",
  );
}
