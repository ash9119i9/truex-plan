import type { GoalStatus } from "../../shared/contracts";
import type { ErrorReason } from "../../shared/errors";

// The last failed turn, as the platform reports it. Only the reason, a safe
// message and the HTTP status reach the browser, never provider diagnostics.
export interface TurnFailure {
  reason: ErrorReason;
  message: string;
  httpStatus?: number;
}

export const errorReasons: Record<
  ErrorReason,
  { label: string; hint: string; action: "resume" | "compact" | null }
> = {
  rateLimited: {
    label: "Rate limited",
    hint: "The model provider is limiting requests right now. Wait a moment, then resume.",
    action: "resume",
  },
  quota: {
    label: "Out of credits",
    hint: "The model provider account has no usage or credits left.",
    action: null,
  },
  credentials: {
    label: "Access denied",
    hint: "The model provider rejected the configured credentials.",
    action: null,
  },
  providerDown: {
    label: "Provider unavailable",
    hint: "The model provider is unavailable or the connection dropped. Resume to try again.",
    action: "resume",
  },
  contextWindow: {
    label: "Conversation too long",
    hint: "The conversation no longer fits the model's context window. Compacting summarizes earlier turns so the work can continue.",
    action: "compact",
  },
  other: { label: "Stopped by an error", hint: "", action: "resume" },
};

// Where to look, per provider. Matched on the model profile's provider name.
const providerTips: {
  match: RegExp;
  quota: string;
  credentials: string;
}[] = [
  {
    match: /openrouter/i,
    quota:
      "Check credits on OpenRouter. Free models have low daily request limits.",
    credentials: "Check the OpenRouter API key in the model profile.",
  },
  {
    match: /bedrock|amazon|aws/i,
    quota:
      "Check the Bedrock service quotas for this model in the AWS console.",
    credentials:
      "Check the IAM permissions and model access for this Bedrock model.",
  },
  {
    match: /openai/i,
    quota: "Check usage and billing in the OpenAI platform dashboard.",
    credentials: "Check the OpenAI API key and its project access.",
  },
  {
    match: /anthropic|claude/i,
    quota: "Check usage and billing in the Anthropic Console.",
    credentials: "Check the Anthropic API key in the model profile.",
  },
  {
    match: /gemini|google|vertex/i,
    quota: "Check quotas in Google AI Studio or the Google Cloud console.",
    credentials: "Check the Google API key and its access to this model.",
  },
];
const fallbackTip = {
  quota:
    "Ask your administrator to check the provider account's usage and billing.",
  credentials:
    "Ask your administrator to check the API key and model permissions in the model profile.",
};

export function providerTip(provider: string | undefined, reason: ErrorReason) {
  if (reason !== "quota" && reason !== "credentials") return null;
  const tip =
    providerTips.find((t) => provider && t.match.test(provider)) ?? fallbackTip;
  return tip[reason];
}

// Codex keeps its own goal status; the reason explains it while the goal is
// stopped by an error.
export function goalFailure(
  status: GoalStatus,
  failure: TurnFailure | null | undefined,
) {
  return (status === "blocked" || status === "usageLimited") && failure
    ? failure
    : null;
}

// A turn error from a turn.completed or error event, if there is one.
export function turnFailure(error: any): TurnFailure | null {
  if (!error || typeof error.message !== "string") return null;
  const reason: ErrorReason =
    error.reason && error.reason in errorReasons ? error.reason : "other";
  return {
    reason,
    message: error.message,
    ...(typeof error.httpStatus === "number"
      ? { httpStatus: error.httpStatus }
      : {}),
  };
}
