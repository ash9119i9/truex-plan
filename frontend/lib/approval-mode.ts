// Alpha approval modes: which questions and tool approvals a chat answers on
// its own. Pure helpers plus thin API wrappers so the picker stays simple.
import type {
  ApprovalMode,
  ApprovalModesConfig,
  ApprovalRecord,
} from "../../shared/contracts";
import { api, warnFailure } from "./api.ts";

export const approvalModesOff: ApprovalModesConfig = {
  enabled: false,
  defaultMode: "ask",
  autopilot: false,
  nameHeuristic: false,
};

export interface ModeOption {
  value: ApprovalMode;
  label: string;
  description: string;
}
// Copy from the r2 approval mode menu. Secrets and plan approvals always ask,
// whatever the mode.
const modeOptions: ModeOption[] = [
  {
    value: "ask",
    label: "Ask",
    description: "Asks before running tools or changing files.",
  },
  {
    value: "readOnly",
    label: "Read-only",
    description: "Reads and searches. Never writes or runs commands.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "Runs tools without asking.",
  },
];
export const MODE_FOOTNOTE = "Secrets and plan approvals always ask.";

export interface ModePicker {
  options: ModeOption[];
  selected: ApprovalMode;
}
// What the picker shows, or null when the feature is off. The session's mode
// wins, then a choice made before the chat existed, then the default.
export function modePicker(
  config: ApprovalModesConfig,
  session: { approvalMode?: ApprovalMode } | null,
  draft: ApprovalMode | null = null,
): ModePicker | null {
  if (!config.enabled) return null;
  const options = modeOptions.filter(
    (o) => o.value !== "auto" || config.autopilot,
  );
  const wanted =
    session?.approvalMode ?? (session ? null : draft) ?? config.defaultMode;
  const selected = options.some((o) => o.value === wanted)
    ? wanted
    : options.some((o) => o.value === config.defaultMode)
      ? config.defaultMode
      : "ask";
  return { options, selected };
}

function isConfig(value: any): value is ApprovalModesConfig {
  return (
    !!value &&
    typeof value.enabled === "boolean" &&
    typeof value.defaultMode === "string"
  );
}
// Any failure, or an unexpected shape, falls back to the feature being off,
// the safe default. Failures are logged so they are not mistaken for "off".
export async function loadApprovalModes(): Promise<ApprovalModesConfig> {
  try {
    const data = await api("/api/features");
    const config = data?.approvalModes;
    return isConfig(config)
      ? { ...approvalModesOff, ...config, enabled: config.enabled === true }
      : approvalModesOff;
  } catch (error) {
    warnFailure("feature flags", error);
    return approvalModesOff;
  }
}
export async function setApprovalMode(
  sessionId: string,
  mode: ApprovalMode,
): Promise<ApprovalMode> {
  const data = await api(
    `/api/sessions/${encodeURIComponent(sessionId)}/approval-mode`,
    { mode },
  );
  return (data?.mode as ApprovalMode) || mode;
}

// --- Audit record labels --------------------------------------------------
export type AutoMode = NonNullable<ApprovalRecord["autoMode"]>;
export type RecordItem = ApprovalRecord["items"][number];
export type ToolDecision = Extract<
  RecordItem,
  { kind: "toolApproval" }
>["decision"];
export type ModeRecord = ApprovalRecord;

export type Tone = "allowed" | "declined" | "muted";
const decisions: Record<ToolDecision, { text: string; tone: Tone }> = {
  allowedOnce: { text: "Allowed once", tone: "allowed" },
  allowedSession: { text: "Allowed for this chat", tone: "allowed" },
  allowedChat: { text: "Allowed for this chat", tone: "allowed" },
  allowedAlways: { text: "Always allowed", tone: "allowed" },
  declined: { text: "Not allowed", tone: "declined" },
  expired: { text: "No answer — timed out", tone: "muted" },
  interrupted: { text: "No answer — stopped", tone: "muted" },
};
const autoLabels: Record<AutoMode, string> = {
  readOnly: "Auto-allowed (read-only)",
  auto: "Auto-accepted (Autopilot)",
  grant: "Allowed for this chat",
};

// The mode that answered this record, if a mode (not a timeout) did.
export function autoModeLabel(record: ModeRecord): string | null {
  return record.outcome === "auto" && record.autoMode
    ? autoLabels[record.autoMode] || null
    : null;
}
export function decisionLabel(
  record: ModeRecord,
  decision: ToolDecision,
): { text: string; tone: Tone } {
  const d = decisions[decision] || decisions.declined;
  const auto = autoModeLabel(record);
  return auto && d.tone !== "declined" ? { text: auto, tone: "allowed" } : d;
}
// The footer line before the time.
export function recordSummary(record: ModeRecord): string {
  if (record.outcome === "answered") return "You answered";
  if (record.outcome === "auto")
    return autoModeLabel(record) ?? "Recommended option chosen";
  return "Closed";
}
// How an automatically chosen answer is annotated.
export function autoAnswerNote(record: ModeRecord): string {
  return record.autoMode === "auto"
    ? "chosen by Autopilot"
    : "chosen automatically, no reply in time";
}
