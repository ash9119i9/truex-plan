import type { Goal } from "../../shared/contracts";
import type { ConversationFile } from "../../shared/assistant-capabilities";
import type { Entry } from "./chat";

export const SUMMARY_PREVIEW_CHARS = 280;

export interface ClosingSummary {
  text: string;
  preview: string;
  truncated: boolean;
}

// Codex reports goal times in Unix seconds; accept milliseconds too.
function goalTimeMs(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return null;
  return value > 1e12 ? value : value * 1000;
}

// Cuts at a word boundary when one is close, so the preview reads cleanly.
export function previewText(text: string, max = SUMMARY_PREVIEW_CHARS) {
  if (text.length <= max) return { preview: text, truncated: false };
  const cut = text.slice(0, max);
  const space = cut.search(/\s\S*$/);
  const head = (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
  return { preview: `${head}…`, truncated: true };
}

// Entries carry no timestamps, so order stands in for time: the goal starts at
// its matching /goal set entry (or the start of the list) and the last final
// assistant reply after that point is the closing one.
export function closingSummary(
  entries: Entry[],
  goal: Goal,
): ClosingSummary | null {
  let start = 0;
  entries.forEach((entry, index) => {
    if (
      entry.kind === "message" &&
      entry.command?.method === "thread/goal/set" &&
      entry.command.result?.goal?.createdAt === goal.createdAt &&
      goal.createdAt !== null
    )
      start = index + 1;
  });
  for (let i = entries.length - 1; i >= start; i--) {
    const entry = entries[i];
    if (
      entry.kind !== "message" ||
      entry.role !== "assistant" ||
      entry.final !== true
    )
      continue;
    const text = entry.text.trim();
    if (!text) continue;
    return { text, ...previewText(text) };
  }
  return null;
}

// Documents saved between the goal's creation and its completion. An
// unfinished goal has no end yet. Visualizations have their own viewer.
export function goalDocuments(
  documents: ConversationFile[],
  goal: Goal,
): ConversationFile[] {
  const start = goalTimeMs(goal.createdAt);
  if (start === null) return [];
  const updated = goalTimeMs(goal.updatedAt);
  // Goal times are whole seconds, so allow the rest of the final second.
  const end =
    goal.status === "complete" && updated !== null
      ? updated + 999
      : Number.POSITIVE_INFINITY;
  return documents
    .filter((file) => {
      if (file.kind === "visualization") return false;
      const created = Date.parse(file.createdAt ?? "");
      return Number.isFinite(created) && created >= start && created <= end;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
